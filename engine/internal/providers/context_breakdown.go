// Package providers — context_breakdown.go
//
// BuildContextBreakdown assembles a per-category token count breakdown for the
// active run. Invoked at prompt-assembly time (from the backend runloop, which
// holds the fully-assembled stream options) after all injection steps.
//
// It lives in the providers package — not session — because the fully-assembled
// prompt (system + messages + tools) is available in the backend runloop, and
// backend imports providers but session imports backend (so a session-package
// builder could not be reached from the runloop without an import cycle). The
// wire event types live in internal/types; the translation into the engine_*
// wire event happens in the session layer via types.ContextBreakdownEvent.
//
// The breakdown resolves each category's token count through a three-tier
// resolver (countText):
//  1. Provider CountTokens (exact) — the provider's native count-tokens
//     endpoint, per category. The per-call cost is bounded by a content-hash
//     cache: unchanged content is never re-counted.
//  2. Local BPE (local) — the tiktoken-go encoder for the model.
//  3. Char/4 (approximate) — the heuristic fallback when no encoder resolves.
//
// After the first UsageEvent arrives, ReconcileBreakdown records the delta
// between the provider's reported input_tokens and the itemized sum as an
// explicit "unaccounted" row — drift is surfaced, never silently absorbed.
package providers

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ToolTokenCountOverhead is the fixed per-request token overhead the provider
// adds when tools are present (tool-use system scaffolding). Subtracted once
// from the tools category total so the itemized tool rows sum to the real
// marginal cost of the tool definitions rather than over-counting the
// scaffolding on every tool.
const ToolTokenCountOverhead = 500

// ContextFile is the minimal shape the breakdown builder needs for a single
// injected context file: its absolute path and content. Kept local so the
// builder does not couple to the conversation or ioncontext discovery types;
// callers copy Path + Content across.
type ContextFile struct {
	Path    string
	Content string
}

// BreakdownCategory is one row in the context breakdown.
type BreakdownCategory struct {
	Name   string        `json:"name"`
	Kind   string        `json:"kind"` // "system", "file", "extension", "memory", "tool", "conversation", "unaccounted"
	Tokens int           `json:"tokens"`
	Tier   TokenizerTier `json:"tier"`
	// Path is set for "file" kind rows (absolute path of context file).
	Path string `json:"path,omitempty"`
}

// ContextBreakdown is the assembled per-category token breakdown for a run.
type ContextBreakdown struct {
	Categories    []BreakdownCategory `json:"categories"`
	ContextWindow int                 `json:"contextWindow"`
	TotalTokens   int                 `json:"totalTokens"`
	// APIReportedTotal is set to the provider's reported input_tokens after
	// the first UsageEvent reconciliation. Zero until reconciled.
	APIReportedTotal int `json:"apiReportedTotal,omitempty"`
	// Unaccounted is the delta between APIReportedTotal and the itemized sum.
	// Set after reconciliation. May be positive or negative.
	Unaccounted int `json:"unaccounted,omitempty"`
	// CacheReadTokens is the provider-reported cache-read input tokens.
	// Annotation only — not summed into TotalTokens.
	CacheReadTokens int `json:"cacheReadTokens,omitempty"`
	// CacheCreationTokens is the provider-reported cache-creation input tokens.
	// Annotation only — not summed into TotalTokens.
	CacheCreationTokens int    `json:"cacheCreationTokens,omitempty"`
	Model               string `json:"model"`
	// OccupancyTokens is the engine's authoritative context-window occupancy
	// figure, supplied by the caller (the builder cannot derive it: occupancy
	// comes from the conversation's persisted provider usage, and this package
	// must not import conversation). Set via SetOccupancy.
	//
	// Distinct from TotalTokens (the itemized estimate this file computes) and
	// from APIReportedTotal (the raw last-turn provider figure). See
	// types.ContextBreakdownEvent.OccupancyTokens for the full contract.
	OccupancyTokens int `json:"occupancyTokens,omitempty"`
}

// cachedCount stores a resolved count alongside the tier it was resolved at so
// a cache hit returns the correct tier (a cached provider "exact" count must
// not be reported as "local").
type cachedCount struct {
	count int
	tier  TokenizerTier
}

// breakdownCache maps content-hash keys → cachedCount. Bounds the per-category
// provider CountTokens calls: unchanged content across successive assemblies is
// counted once.
var breakdownCache sync.Map // map[string]cachedCount

// countText resolves a token count through the three-tier resolver:
//  1. content-hash cache (returns the cached count + its original tier)
//  2. provider CountTokens for this category's content (tier=exact)
//  3. local BPE via LocalTokenCount (tier=local)
//  4. char/4 heuristic (tier=approximate)
//
// The cacheKey scopes the content hash to a category so identical text in two
// categories is still counted per-category.
func countText(ctx context.Context, model string, provider LlmProvider, text, cacheKey string) (int, TokenizerTier) {
	if text == "" {
		return 0, TierExact
	}

	key := ContentHashKey(text, model+"/"+cacheKey)
	if v, ok := breakdownCache.Load(key); ok {
		c := v.(cachedCount) //nolint:errcheck // best-effort; failure not actionable here
		return c.count, c.tier
	}

	// Tier 1: provider native count-tokens (exact), one call per category.
	if provider != nil {
		n, err := provider.CountTokens(ctx, CountTokensRequest{
			Model:    model,
			Messages: []types.LlmMessage{{Role: "user", Content: text}},
		})
		if err == nil {
			breakdownCache.Store(key, cachedCount{count: n, tier: TierExact})
			return n, TierExact
		}
	}

	// Tier 2: local BPE encoder.
	if n, tier, err := LocalTokenCount(model, text); err == nil {
		breakdownCache.Store(key, cachedCount{count: n, tier: tier})
		return n, tier
	}

	// Tier 3: char/4 heuristic.
	n := EstimateTokensChar4(text)
	breakdownCache.Store(key, cachedCount{count: n, tier: TierApproximate})
	return n, TierApproximate
}

// appendToolRows batch-counts all tool schemas in a single CountTokens call
// (matching what Stream sends), subtracts one fixed ToolTokenCountOverhead to
// get the content-only total, and distributes that total per-tool in proportion
// to each tool's serialized byte size. When the provider has no count-tokens
// endpoint, it falls back to a local BPE estimate per tool. No synthetic
// overhead row is appended and no row is ever negative.
func appendToolRows(ctx context.Context, bd *ContextBreakdown, model string, provider LlmProvider, toolDefs []types.LlmToolDef) error {
	var batchTotal int
	var batchTier TokenizerTier

	if provider != nil {
		n, err := provider.CountTokens(ctx, CountTokensRequest{
			Model: model,
			Tools: toolDefs,
		})
		if err == nil {
			batchTotal = n - ToolTokenCountOverhead
			if batchTotal < 0 {
				batchTotal = 0
			}
			batchTier = TierExact
		}
	}

	if batchTier == "" {
		// Fallback: estimate each tool's size locally and sum, then subtract
		// the fixed overhead once.
		for _, tool := range toolDefs {
			toolJSON, err := json.Marshal(tool)
			if err != nil {
				return err
			}
			n, _, lerr := LocalTokenCount(model, string(toolJSON))
			if lerr != nil {
				n = EstimateTokensChar4(string(toolJSON))
			}
			batchTotal += n
		}
		if batchTotal > ToolTokenCountOverhead {
			batchTotal -= ToolTokenCountOverhead
		} else {
			batchTotal = 0
		}
		batchTier = TierLocal
	}

	// Compute each tool's serialized byte size for proportional distribution.
	toolSizes := make([]int, len(toolDefs))
	totalEstimated := 0
	for i, tool := range toolDefs {
		toolJSON, err := json.Marshal(tool)
		if err != nil {
			return err
		}
		toolSizes[i] = len(toolJSON)
		totalEstimated += toolSizes[i]
	}

	for i, tool := range toolDefs {
		toolTokens := 0
		if totalEstimated > 0 {
			toolTokens = batchTotal * toolSizes[i] / totalEstimated
		}
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: tool.Name, Kind: "tool", Tokens: toolTokens, Tier: batchTier,
		})
	}
	return nil
}

// messageCountableText renders one message's content as the text that may be
// safely handed to a length-based token estimator, plus a separate fixed token
// cost for any image blocks it carried.
//
// Image blocks are the reason this exists. Their wire form carries the full
// base64 payload in source.data, which can be megabytes, while the provider
// charges a roughly fixed per-image cost. Marshaling the block whole and
// dividing its byte length by 4 counts a 1MB image as ~250K tokens. Observed:
// a conversation the provider billed at 255,897 input tokens itemized at
// 1,034,443 here, because 59% of its bytes were base64 inside image-bearing
// messages. The heavy source is therefore stripped before marshaling and each
// image contributes types.ImageBlockTokenEstimate instead.
//
// Both content shapes are handled: the typed []types.LlmContentBlock slice, and
// the []any-of-map[string]any shape that content takes after a JSON round-trip
// through disk. This mirrors conversation.estimateBlocksTokens /
// estimateAnyBlockTokens, which solved the identical defect for the compaction
// numerator; the shared fixed-cost constant lives in internal/types so the two
// estimates cannot drift.
//
// A marshal failure yields the empty string for that element rather than
// falling back to the raw value, so a base64 payload can never leak into the
// counted text by way of an error path.
func messageCountableText(msg types.LlmMessage) (string, int) {
	switch c := msg.Content.(type) {
	case string:
		return c, 0
	case []types.LlmContentBlock:
		var sb strings.Builder
		imageTokens := 0
		for i := range c {
			blk := c[i]
			if blk.Type == "image" || blk.Source != nil {
				imageTokens += types.ImageBlockTokenEstimate
				// Drop the heavy source; the remaining metadata is small and
				// still worth counting.
				blk.Source = nil
			}
			b, err := json.Marshal(blk)
			if err != nil {
				utils.LogWithFields(utils.LevelWarn, "ContextBreakdown", "marshal content block failed, skipping from count", map[string]any{
					"role": msg.Role, "block_type": blk.Type, "error": err.Error(),
				})
				continue
			}
			sb.Write(b)
		}
		return sb.String(), imageTokens
	case []any:
		var sb strings.Builder
		imageTokens := 0
		for _, el := range c {
			text, imgTokens := anyBlockCountableText(el, msg.Role)
			imageTokens += imgTokens
			sb.WriteString(text)
		}
		return sb.String(), imageTokens
	default:
		b, err := json.Marshal(c)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "ContextBreakdown", "marshal message content failed, skipping from count", map[string]any{
				"role": msg.Role, "error": err.Error(),
			})
			return "", 0
		}
		return string(b), 0
	}
}

// anyBlockCountableText is messageCountableText's per-element helper for content
// that arrived as a JSON-decoded map[string]any (the disk-reload shape). An
// image is detected by type=="image" or the presence of a "source" key, matching
// conversation.estimateAnyBlockTokens.
func anyBlockCountableText(el any, role string) (string, int) {
	m, ok := el.(map[string]any)
	if !ok {
		// Unknown shape (e.g. a bare string element) — count it as-is.
		b, err := json.Marshal(el)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "ContextBreakdown", "marshal untyped content element failed, skipping from count", map[string]any{
				"role": role, "error": err.Error(),
			})
			return "", 0
		}
		return string(b), 0
	}

	isImage := m["type"] == "image"
	if _, hasSource := m["source"]; hasSource {
		isImage = true
	}
	imageTokens := 0
	if isImage {
		imageTokens = types.ImageBlockTokenEstimate
		stripped := make(map[string]any, len(m))
		for k, v := range m {
			if k == "source" {
				continue
			}
			stripped[k] = v
		}
		m = stripped
	}
	b, err := json.Marshal(m)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "ContextBreakdown", "marshal content map failed, skipping from count", map[string]any{
			"role": role, "error": err.Error(),
		})
		return "", imageTokens
	}
	return string(b), imageTokens
}

// appendConversationRow counts the conversation structurally via CountTokens —
// passing the messages array exactly as Stream would send it — and appends a
// single "conversation" row. Falls back to a per-message local count when the
// provider has no count-tokens endpoint.
//
// Returns nothing: a per-block marshal failure is logged and that block is
// excluded from the count (see messageCountableText) rather than aborting the
// whole breakdown. One unrepresentable content block should cost its own row's
// accuracy, not the entire emission — and the previous error return, which
// propagated such a failure all the way out of BuildContextBreakdown, is why a
// single bad block could suppress the breakdown event entirely.
func appendConversationRow(ctx context.Context, bd *ContextBreakdown, model string, provider LlmProvider, messages []types.LlmMessage) {
	var conversationTokens int
	var conversationTier TokenizerTier

	if provider != nil {
		n, err := provider.CountTokens(ctx, CountTokensRequest{
			Model:    model,
			Messages: messages,
		})
		if err == nil {
			conversationTokens = n
			conversationTier = TierExact
		}
	}

	if conversationTier == "" {
		// Fall back to a per-message local count. Image blocks contribute a
		// fixed per-image cost and their base64 payload is excluded from the
		// counted text — see messageCountableText. The provider-exact path
		// above needs no such adjustment: the provider is authoritative about
		// how it bills its own images.
		imageTokens := 0
		for _, msg := range messages {
			text, imgTokens := messageCountableText(msg)
			imageTokens += imgTokens
			n, t := countText(ctx, model, nil, text, "msg:"+msg.Role)
			conversationTokens += n
			if conversationTier == "" || (t == TierApproximate && conversationTier != TierApproximate) {
				conversationTier = t
			}
		}
		conversationTokens += imageTokens
		if conversationTier == "" {
			conversationTier = TierApproximate
		}
		if imageTokens > 0 {
			utils.LogWithFields(utils.LevelDebug, "ContextBreakdown", "conversation row: counted image blocks at the fixed per-image estimate", map[string]any{
				"model": model, "image_tokens": imageTokens, "total": conversationTokens,
			})
		}
	}

	bd.Categories = append(bd.Categories, BreakdownCategory{
		Name: "conversation", Kind: "conversation", Tokens: conversationTokens, Tier: conversationTier,
	})
}

// BuildContextBreakdown assembles a per-category token breakdown from the
// fully-assembled options plus the individual injected blocks. provider may be
// nil (no network); the resolver then falls back to local BPE / char4.
func BuildContextBreakdown(
	ctx context.Context,
	model string,
	provider LlmProvider,
	opts *types.LlmStreamOptions,
	contextFiles []ContextFile,
	extensionContext []string,
	sessionMemory string,
) (*ContextBreakdown, error) {
	bd := &ContextBreakdown{Model: model}

	// 1. System prompt.
	if opts != nil && opts.System != "" {
		n, tier := countText(ctx, model, provider, opts.System, "system")
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: "system", Kind: "system", Tokens: n, Tier: tier,
		})
	}

	// 2. Per context file.
	for _, cf := range contextFiles {
		if cf.Content == "" {
			continue
		}
		n, tier := countText(ctx, model, provider, cf.Content, "file:"+cf.Path)
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: cf.Path, Kind: "file", Tokens: n, Tier: tier, Path: cf.Path,
		})
	}

	// 3. Session memory.
	if sessionMemory != "" {
		n, tier := countText(ctx, model, provider, sessionMemory, "memory")
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: "memory", Kind: "memory", Tokens: n, Tier: tier,
		})
	}

	// 4. Extension-injected context blocks.
	for i, block := range extensionContext {
		if block == "" {
			continue
		}
		n, tier := countText(ctx, model, provider, block, "ext:"+strconv.Itoa(i))
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: "extension:" + strconv.Itoa(i), Kind: "extension", Tokens: n, Tier: tier,
		})
	}

	// 5. Tools. All tool schemas are counted in a SINGLE CountTokens call
	// (matching what Stream sends: the whole tool array in one request). One
	// fixed ToolTokenCountOverhead is subtracted from that batch total to get
	// the content-only cost, which is then distributed per-tool proportionally
	// by each tool's serialized byte size. No synthetic "tool_overhead" row and
	// no negative rows — the overhead is folded into the batch total once.
	if opts != nil && len(opts.Tools) > 0 {
		if err := appendToolRows(ctx, bd, model, provider, opts.Tools); err != nil {
			return nil, err
		}
	}

	// 6. Conversation. The messages are counted structurally via CountTokens —
	// passing opts.Messages as the real messages array, exactly as Stream would
	// send them — rather than counting a marshaled JSON blob (which inflates the
	// count with structural noise). Tools are counted separately in step 5, so
	// this call passes messages only. Image blocks contribute a fixed per-image
	// cost on the local-fallback path; their base64 payload is never counted by
	// byte length.
	if opts != nil && len(opts.Messages) > 0 {
		appendConversationRow(ctx, bd, model, provider, opts.Messages)
	}

	// Total and context window.
	total := 0
	for _, c := range bd.Categories {
		total += c.Tokens
	}
	bd.TotalTokens = total
	if info := GetModelInfo(model); info != nil {
		bd.ContextWindow = info.ContextWindow
	}

	utils.LogWithFields(utils.LevelDebug, "ContextBreakdown", "built breakdown", map[string]any{"model": model, "count": len(bd.Categories), "max": total})
	return bd, nil
}

// SetOccupancy records the engine's authoritative context-window occupancy on
// the breakdown so the emitted event carries it alongside the itemized sum.
//
// The builder cannot compute this itself. Occupancy is derived from the
// conversation's persisted provider usage (conversation.GetContextUsage), and
// this package must not import conversation — the dependency runs the other
// way. So the caller, which has the conversation in hand, supplies it.
//
// A non-positive value is ignored rather than written: zero means "the engine
// has no occupancy figure", and that is already the field's zero value. This
// keeps a caller with nothing to report from having to branch.
func (bd *ContextBreakdown) SetOccupancy(tokens int) {
	if bd == nil || tokens <= 0 {
		return
	}
	bd.OccupancyTokens = tokens
}

// ReconcileBreakdown updates the breakdown with the provider's reported total
// after the first UsageEvent. Records the unaccounted delta as an explicit row
// rather than silently absorbing it into an existing category. The cache token
// counts are recorded as annotations only — they are NOT summed into
// TotalTokens. The unaccounted row is only appended when the drift is
// non-trivial (> unaccountedThreshold or > 5% of the reported total); the
// Unaccounted field itself is always set honestly regardless.
func ReconcileBreakdown(bd *ContextBreakdown, apiReportedTotal, cacheReadTokens, cacheCreationTokens int) {
	if bd == nil {
		return
	}
	bd.APIReportedTotal = apiReportedTotal
	bd.CacheReadTokens = cacheReadTokens
	bd.CacheCreationTokens = cacheCreationTokens
	bd.Unaccounted = apiReportedTotal - bd.TotalTokens

	// Only surface the unaccounted row when the drift is non-trivial. Never
	// scale or silently absorb: the Unaccounted value above is always honest;
	// this only governs whether a visible row is added. Threshold is the larger
	// of a fixed floor and 5% of the reported total so small prompts still
	// surface proportionally-significant drift.
	const unaccountedFloor = 50 // tokens
	threshold := unaccountedFloor
	if pct := apiReportedTotal * 5 / 100; pct > threshold {
		threshold = pct
	}
	if bd.Unaccounted > threshold || bd.Unaccounted < -threshold {
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name:   "unaccounted",
			Kind:   "unaccounted",
			Tokens: bd.Unaccounted,
			Tier:   TierExact,
		})
	}
}

// ToNormalizedEvent converts a ContextBreakdown into the ContextBreakdownEvent
// wire shape (string tiers, ContextBreakdownCategory rows).
func (bd *ContextBreakdown) ToNormalizedEvent() *types.ContextBreakdownEvent {
	if bd == nil {
		return nil
	}
	cats := make([]types.ContextBreakdownCategory, 0, len(bd.Categories))
	for _, c := range bd.Categories {
		cats = append(cats, types.ContextBreakdownCategory{
			Name:   c.Name,
			Kind:   c.Kind,
			Tokens: c.Tokens,
			Tier:   string(c.Tier),
			Path:   c.Path,
		})
	}
	return &types.ContextBreakdownEvent{
		Categories:          cats,
		ContextWindow:       bd.ContextWindow,
		TotalTokens:         bd.TotalTokens,
		APIReportedTotal:    bd.APIReportedTotal,
		Unaccounted:         bd.Unaccounted,
		CacheReadTokens:     bd.CacheReadTokens,
		CacheCreationTokens: bd.CacheCreationTokens,
		Model:               bd.Model,
		OccupancyTokens:     bd.OccupancyTokens,
	}
}
