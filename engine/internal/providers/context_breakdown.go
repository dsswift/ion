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
		c := v.(cachedCount)
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

// appendConversationRow counts the conversation structurally via CountTokens —
// passing the messages array exactly as Stream would send it — and appends a
// single "conversation" row. Falls back to a per-message local count when the
// provider has no count-tokens endpoint.
func appendConversationRow(ctx context.Context, bd *ContextBreakdown, model string, provider LlmProvider, messages []types.LlmMessage) error {
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
		// Fall back to a per-message local count.
		for _, msg := range messages {
			var text string
			switch v := msg.Content.(type) {
			case string:
				text = v
			default:
				b, err := json.Marshal(v)
				if err != nil {
					return err
				}
				text = string(b)
			}
			n, t := countText(ctx, model, nil, text, "msg:"+msg.Role)
			conversationTokens += n
			if conversationTier == "" || (t == TierApproximate && conversationTier != TierApproximate) {
				conversationTier = t
			}
		}
		if conversationTier == "" {
			conversationTier = TierApproximate
		}
	}

	bd.Categories = append(bd.Categories, BreakdownCategory{
		Name: "conversation", Kind: "conversation", Tokens: conversationTokens, Tier: conversationTier,
	})
	return nil
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
	// this call passes messages only.
	if opts != nil && len(opts.Messages) > 0 {
		if err := appendConversationRow(ctx, bd, model, provider, opts.Messages); err != nil {
			return nil, err
		}
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
	}
}
