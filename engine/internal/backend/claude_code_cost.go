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
//
// The CLI's turns, usage, and duration are per process, not cumulative, so a
// parked turn's are held and added to the woken run's close: the run a
// caller asked for reports every turn it took, across the park.
func (b *ClaudeCodeBackend) normalizeRunCost(runID, costKey string, e *types.TaskCompleteEvent, parking bool) {
	if parking {
		b.mu.Lock()
		held := b.heldFigures[costKey]
		held.add(figuresOf(e))
		b.heldFigures[costKey] = held
		b.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "cost baseline held for park", map[string]any{
			"run_id":     runID,
			"key":        costKey,
			"cumulative": e.CostUsd,
			"held_turns": held.turns,
		})
		return
	}

	b.mu.Lock()
	if held, ok := b.heldFigures[costKey]; ok {
		delete(b.heldFigures, costKey)
		held.add(figuresOf(e))
		held.apply(e)
	}
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

// runFigures are the per-process figures of a CLI result: what a parked turn
// holds for the run that wakes it.
type runFigures struct {
	turns                int
	durationMs           int64
	input, output        int
	cacheRead, cacheMade int
}

func figuresOf(e *types.TaskCompleteEvent) runFigures {
	return runFigures{
		turns:      e.NumTurns,
		durationMs: e.DurationMs,
		input:      derefInt(e.Usage.InputTokens),
		output:     derefInt(e.Usage.OutputTokens),
		cacheRead:  derefInt(e.Usage.CacheReadInputTokens),
		cacheMade:  derefInt(e.Usage.CacheCreationInputTokens),
	}
}

func (f *runFigures) add(o runFigures) {
	f.turns += o.turns
	f.durationMs += o.durationMs
	f.input += o.input
	f.output += o.output
	f.cacheRead += o.cacheRead
	f.cacheMade += o.cacheMade
}

// apply writes the summed figures onto the close that reports them.
func (f runFigures) apply(e *types.TaskCompleteEvent) {
	e.NumTurns, e.DurationMs = f.turns, f.durationMs
	e.Usage.InputTokens, e.Usage.OutputTokens = &f.input, &f.output
	e.Usage.CacheReadInputTokens, e.Usage.CacheCreationInputTokens = &f.cacheRead, &f.cacheMade
}

// resultFailed reports whether one CLI line's events are an error result:
// the error, then the close that carries what the run spent.
func resultFailed(events []types.NormalizedEvent) bool {
	for _, ev := range events {
		if e, ok := ev.Data.(*types.ErrorEvent); ok && e.IsError {
			return true
		}
	}
	return false
}
