package session

// aggregate_cost.go — compute the total LLM cost for a conversation and all
// its dispatched descendant conversations.
//
// ComputeAggregateCost sums the persisted conv.TotalCost for the given
// conversation plus every child conversation reachable via AgentDispatchEntries
// (persisted .tree.jsonl) and the live DispatchRegistry (in-flight dispatches
// whose .tree.jsonl entry may not yet exist). Each conversation ID is counted
// at most once (visited-set guards cycles and duplicate IDs).
//
// Design: recompute-on-demand. Called from ComputeAndEmitContextBreakdown on
// every get_context_breakdown request. No accumulator to reconcile; freshest
// available on every on-demand query. A mid-turn child may undercount by its
// unflushed turn — bounded and self-healing on next flush/open.

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ComputeAggregateCost returns the sum of LoadLlmHeaderCost for convID and
// every descendant conversation reachable via the dispatch tree.
//
// liveConvIDs is an optional set of additional child conversation IDs from the
// live DispatchRegistry (in-flight children whose tree entries are not yet
// persisted). Pass nil when there are no live dispatches.
//
// dir is the conversations directory; empty uses the default
// (~/.ion/conversations). It exists primarily so tests can point the walk at a
// temp dir.
//
// Each conversation ID is counted at most once regardless of how many times it
// appears in the tree.
//
// Errors encountered while loading individual conversations are logged at Debug
// and treated as zero-cost (best-effort); they are never surfaced to the
// caller. The returned error is always nil today, but the signature keeps room
// for future hard-failure modes.
func ComputeAggregateCost(convID string, liveConvIDs []string, dir string) (float64, error) {
	if convID == "" {
		return 0, nil
	}

	visited := make(map[string]bool)
	var total float64

	var walkCost func(id string) float64
	walkCost = func(id string) float64 {
		if id == "" || visited[id] {
			return 0
		}
		visited[id] = true

		cost, err := conversation.LoadLlmHeaderCost(id, dir)
		if err != nil {
			utils.Debug("Session", fmt.Sprintf("ComputeAggregateCost: header cost load failed id=%s err=%v (counting 0)", id, err))
			return 0
		}
		sum := cost

		conv, err := conversation.Load(id, dir)
		if err != nil {
			// No tree available — the header cost stands alone (no children).
			utils.Debug("Session", fmt.Sprintf("ComputeAggregateCost: conv load failed id=%s err=%v (no children)", id, err))
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

	total += walkCost(convID)
	for _, id := range liveConvIDs {
		// visited set naturally dedups live children that also appear in the
		// persisted tree.
		total += walkCost(id)
	}

	utils.Debug("Session", fmt.Sprintf("ComputeAggregateCost: convID=%s conversations=%d total=%f", convID, len(visited), total))
	return total, nil
}
