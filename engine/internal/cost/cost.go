// Package cost provides centralized, cache-aware LLM cost calculation for
// the Ion engine. All per-turn and per-conversation cost math lives here.
//
// # Design
//
// TurnCost computes the USD cost of a single LLM turn using cache-aware
// pricing. Cache-creation tokens are priced at the model's explicit
// CostPer1kCacheCreation rate, falling back to 1.25× the base input rate
// when the model catalog lacks explicit cache pricing. Cache-read tokens use
// the explicit CostPer1kCacheRead rate, falling back to 0.1× the base input
// rate. Regular input tokens (non-cached) use the base CostPer1kInput rate.
//
// ConversationCost walks the dispatch tree for a conversation and returns
// the sum of all descendant costs. It is the canonical source of truth for
// conversation-wide cost aggregation; callers in session/, backend/, and
// normalizer/ all route through here.
package cost

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cacheCreationFallbackMultiplier is applied to CostPer1kInput when the model
// catalog does not carry an explicit CostPer1kCacheCreation rate.
const cacheCreationFallbackMultiplier = 1.25

// cacheReadFallbackMultiplier is applied to CostPer1kInput when the model
// catalog does not carry an explicit CostPer1kCacheRead rate.
const cacheReadFallbackMultiplier = 0.10

// TurnCost returns the USD cost for a single LLM turn given a model identifier
// and token usage. It uses cache-aware pricing:
//
//   - Cache-creation tokens: CostPer1kCacheCreation if set, else 1.25× input rate
//   - Cache-read tokens:     CostPer1kCacheRead if set, else 0.1× input rate
//   - Regular input tokens:  CostPer1kInput (base rate)
//   - Output tokens:         CostPer1kOutput
//
// Returns 0 when the model is not in the registry (unknown / custom models
// without pricing metadata). This matches the historical computeCost behaviour.
func TurnCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		utils.LogWithFields(utils.LevelDebug, "cost", "turn cost model not in registry returning 0", map[string]any{"model": model})
		return 0
	}

	// Determine effective cache pricing rates.
	cacheCreateRate := info.CostPer1kCacheCreation
	if cacheCreateRate == 0 && info.CostPer1kInput > 0 {
		cacheCreateRate = info.CostPer1kInput * cacheCreationFallbackMultiplier
	}

	cacheReadRate := info.CostPer1kCacheRead
	if cacheReadRate == 0 && info.CostPer1kInput > 0 {
		cacheReadRate = info.CostPer1kInput * cacheReadFallbackMultiplier
	}

	// The provider sends all three token buckets. The base InputTokens field
	// from Anthropic carries only the non-cached portion of the prompt when
	// cache-read or cache-creation tokens are also reported; OpenAI and
	// others that don't support caching report zero for the cache buckets.
	regularInput := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	cacheCreate := float64(usage.CacheCreationInputTokens) / 1000.0 * cacheCreateRate
	cacheRead := float64(usage.CacheReadInputTokens) / 1000.0 * cacheReadRate
	output := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput

	total := regularInput + cacheCreate + cacheRead + output

	utils.LogWithFields(utils.LevelDebug, "cost", "turn cost", map[string]any{
		"model": model, "turn": usage.InputTokens, "count": usage.OutputTokens, "cost_usd": total,
	})

	return total
}

// ConversationCost returns the total USD cost for convID and every descendant
// conversation reachable via the dispatch tree. It is the authoritative
// conversation-level cost aggregation function.
//
// Delegates to ConversationCostBreakdown and discards the per-model detail so
// there is one walk implementation.
//
// liveConvIDs is an optional set of additional child conversation IDs from a
// live DispatchRegistry (in-flight children whose tree entries may not yet be
// persisted). Pass nil when there are no live dispatches.
//
// dir is the conversations directory; empty uses the default
// (~/.ion/conversations). It exists primarily so tests can point the walk at a
// temp dir.
func ConversationCost(convID string, liveConvIDs []string, dir string) (float64, error) {
	total, _, err := ConversationCostBreakdown(convID, liveConvIDs, dir)
	return total, err
}

// ConversationCostBreakdown returns the total USD cost for convID and every
// descendant conversation reachable via the dispatch tree, plus a per-model
// breakdown of that spend.
//
// It is the single walk implementation that ConversationCost delegates to.
// Each conversation ID is counted at most once regardless of how many times it
// appears in the tree (visited-set guards cycles and duplicates).
//
// Attribution: token counts come from each conversation's .llm.jsonl header
// (totalInputTokens / totalOutputTokens). A conversation that switched models
// mid-run attributes entirely to the model recorded in its final header;
// per-turn model-switch attribution is not persisted and is out of scope.
// inputTokens is cache-inclusive (matches the persisted totalInputTokens
// semantic — the cache-read/creation split is not stored in the header).
//
// Breakdown rows are keyed by (model, isSelf): the root/viewing conversation's
// own spend is reported as an IsSelf=true row, distinct from any dispatch that
// shares the same model (IsSelf=false). A model used by both the root and its
// dispatches therefore yields two rows. This is purely additive — every
// conversation is still counted exactly once, so the row sum equals the scalar
// total. Rows are sorted IsSelf-first, then by CostUsd descending; tie-breaking
// is alphabetical by Model within each group for stability across runs.
//
// Errors encountered while loading individual conversations are logged at Debug
// and treated as zero-cost (best-effort). The returned error is always nil
// today but the signature preserves room for future hard-failure modes.
func ConversationCostBreakdown(convID string, liveConvIDs []string, dir string) (float64, []types.ModelBreakdown, error) {
	if convID == "" {
		return 0, nil, nil
	}

	visited := make(map[string]bool)

	// modelAcc accumulates per-model token and cost totals during the walk.
	type modelAcc struct {
		conversations int
		inputTokens   int
		outputTokens  int
		costUsd       float64
	}
	// accKey buckets accumulation by (model, isSelf) so the root/viewing
	// conversation's own spend is a distinct row from any dispatch that happens
	// to use the same model. isSelf is true only for the walk's starting convID.
	type accKey struct {
		model  string
		isSelf bool
	}
	byModel := make(map[accKey]*modelAcc)

	var walkCost func(id string) float64
	walkCost = func(id string) float64 {
		if id == "" || visited[id] {
			return 0
		}
		visited[id] = true

		stats, err := conversation.LoadLlmHeaderStats(id, dir)
		if err != nil {
			utils.LogWithFields(utils.LevelDebug, "cost", "conversation cost breakdown header load failed", map[string]any{"conversation_id": id, "error": err.Error()})
			return 0
		}
		sum := stats.TotalCost

		// Accumulate into the per-model bucket. Conversations with an empty
		// model string (e.g. fresh conversations with no LLM turns) are skipped.
		// The root/viewing conversation (id == convID) accumulates into an
		// IsSelf=true bucket so its own spend is reported separately from
		// dispatches that share the same model.
		if stats.Model != "" {
			key := accKey{model: stats.Model, isSelf: id == convID}
			acc, ok := byModel[key]
			if !ok {
				acc = &modelAcc{}
				byModel[key] = acc
			}
			acc.conversations++
			acc.inputTokens += stats.TotalInputTokens
			acc.outputTokens += stats.TotalOutputTokens
			acc.costUsd += stats.TotalCost
		}

		conv, err := conversation.Load(id, dir)
		if err != nil {
			// No tree available — the header cost stands alone (no children reachable).
			utils.LogWithFields(utils.LevelDebug, "cost", "conversation cost breakdown conv load failed", map[string]any{"conversation_id": id, "error": err.Error()})
			return sum
		}

		for _, dispatch := range conversation.AgentDispatchEntries(conv) {
			for _, childID := range dispatch.ConversationIDs {
				sum += walkCost(childID)
			}
			sum += walkCost(dispatch.ConversationID)
		}
		return sum
	}

	total := walkCost(convID)
	for _, id := range liveConvIDs {
		// The visited set naturally dedups live children that also appear in
		// the persisted tree, so each conversation is counted at most once.
		total += walkCost(id)
	}

	// Build the sorted breakdown slice.
	breakdown := make([]types.ModelBreakdown, 0, len(byModel))
	for key, acc := range byModel {
		breakdown = append(breakdown, types.ModelBreakdown{
			Model:         key.model,
			Conversations: acc.conversations,
			InputTokens:   acc.inputTokens,
			OutputTokens:  acc.outputTokens,
			CostUsd:       acc.costUsd,
			IsSelf:        key.isSelf,
		})
	}
	// Sort: IsSelf rows first (the viewing conversation's own spend leads), then
	// the remaining dispatch rows by CostUsd descending. Tie-break alphabetically
	// by Model within each group for stability across runs.
	sort.Slice(breakdown, func(i, j int) bool {
		if breakdown[i].IsSelf != breakdown[j].IsSelf {
			return breakdown[i].IsSelf
		}
		if breakdown[i].CostUsd != breakdown[j].CostUsd {
			return breakdown[i].CostUsd > breakdown[j].CostUsd
		}
		return breakdown[i].Model < breakdown[j].Model
	})

	utils.LogWithFields(utils.LevelDebug, "cost", "conversation cost breakdown", map[string]any{
		"conversation_id": convID, "visited": len(visited), "cost_usd": total, "models": len(breakdown),
	})
	return total, breakdown, nil
}
