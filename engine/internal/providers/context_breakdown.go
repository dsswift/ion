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
	Unaccounted int    `json:"unaccounted,omitempty"`
	Model       string `json:"model"`
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

	// 5. Tools. Each tool marshals to JSON and is counted individually; then a
	// single synthetic "tool_overhead" row carries -ToolTokenCountOverhead so
	// the tool rows sum to the real marginal cost.
	if opts != nil && len(opts.Tools) > 0 {
		for _, tool := range opts.Tools {
			toolJSON, err := json.Marshal(tool)
			if err != nil {
				return nil, err
			}
			n, tier := countText(ctx, model, provider, string(toolJSON), "tool:"+tool.Name)
			bd.Categories = append(bd.Categories, BreakdownCategory{
				Name: tool.Name, Kind: "tool", Tokens: n, Tier: tier,
			})
		}
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: "tool_overhead", Kind: "tool", Tokens: -ToolTokenCountOverhead, Tier: TierExact,
		})
	}

	// 6. Conversation (all messages as one block).
	if opts != nil && len(opts.Messages) > 0 {
		msgJSON, err := json.Marshal(opts.Messages)
		if err != nil {
			return nil, err
		}
		n, tier := countText(ctx, model, provider, string(msgJSON), "conversation")
		bd.Categories = append(bd.Categories, BreakdownCategory{
			Name: "conversation", Kind: "conversation", Tokens: n, Tier: tier,
		})
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

	utils.Debug("ContextBreakdown", "built breakdown model="+model+" categories="+strconv.Itoa(len(bd.Categories))+" total="+strconv.Itoa(total))
	return bd, nil
}

// ReconcileBreakdown updates the breakdown with the provider's reported total
// after the first UsageEvent. Records the unaccounted delta as an explicit row
// rather than silently absorbing it into an existing category.
func ReconcileBreakdown(bd *ContextBreakdown, apiReportedTotal int) {
	if bd == nil {
		return
	}
	bd.APIReportedTotal = apiReportedTotal
	bd.Unaccounted = apiReportedTotal - bd.TotalTokens
	bd.Categories = append(bd.Categories, BreakdownCategory{
		Name:   "unaccounted",
		Kind:   "unaccounted",
		Tokens: bd.Unaccounted,
		Tier:   TierExact,
	})
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
		Categories:       cats,
		ContextWindow:    bd.ContextWindow,
		TotalTokens:      bd.TotalTokens,
		APIReportedTotal: bd.APIReportedTotal,
		Unaccounted:      bd.Unaccounted,
		Model:            bd.Model,
	}
}
