package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// normalizeRunCost converts the CLI's session-cumulative total_cost_usd into the
// per-run cost the engine wire contract carries, and advances the per-session
// baseline it was measured against.
//
// Claude CLI reports a cumulative figure for the whole CLI session; the engine
// wire (and ApiBackend) emit a per-run cost. The delta is the difference from
// the last cumulative seen for this CLI session UUID, so each session tracks
// independently.
//
// # Why parking is a parameter and not the caller's business
//
// A parked turn emits no TaskCompleteEvent, and on this backend that event is
// the ONLY carrier of cost and usage. Advancing the baseline and then dropping
// the event loses the turn's spend twice over: it is absent from this run, and
// it is excluded from the woken run's delta, which is measured from the mark
// this call would have moved. Nothing downstream can recover it, and nothing
// fails — the conversation's aggregate cost is simply short.
//
// Holding the baseline makes the woken run's delta span both turns, which is
// the correct total for a conversation the operator never stopped.
func (b *ClaudeCodeBackend) normalizeRunCost(runID, costKey string, e *types.TaskCompleteEvent, parking bool) {
	if parking {
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "cost baseline held for park", map[string]any{
			"run_id":     runID,
			"key":        costKey,
			"cumulative": e.CostUsd,
		})
		return
	}

	b.mu.Lock()
	cumulativeCost := e.CostUsd
	last := b.lastCumulativeCost[costKey]
	runCost := cumulativeCost - last
	if runCost < 0 {
		// Should not happen; treat as full cost (new session).
		runCost = cumulativeCost
	}
	b.lastCumulativeCost[costKey] = cumulativeCost
	b.mu.Unlock()
	e.CostUsd = runCost

	utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "cost delta", map[string]any{
		"run_id":     runID,
		"key":        costKey,
		"cumulative": cumulativeCost,
		"last":       last,
		"delta":      runCost,
	})
}
