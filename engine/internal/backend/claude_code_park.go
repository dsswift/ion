package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// claude_code_park.go gives a delegated claude-code run the turn-boundary park
// the API run loop has had since ADR-023.
//
// # What a park is
//
// A park is not a new mechanism. It is two events: TaskSuspendEvent naming what
// the session is still waiting on, then the run's ordinary exit. The session
// layer records the park off the suspend (event_translation.go) and revives the
// session with a fresh run when a command completes
// (session/background_task_wake.go). None of that is backend-specific — the
// contract is on the event stream, and the wake is an injected prompt, which for
// this backend means a fresh subprocess resuming the same CLI session.
//
// Only the DECISION was missing here. ApiBackend takes it in its run loop
// (runloop_stop_reason.go); a delegated CLI has no run loop, so it takes it at
// the one place that means the same thing: the result event that would otherwise
// report the turn complete.
//
// # Why this is not optional for this backend
//
// Without it the shape is: the model starts a notifying command, the engine
// tracks it, the model ends its turn, the run reports completion, the session
// goes idle — and the completion, when it arrives, has an idle session and no
// park to claim. The operator sees a conversation that stopped mid-task and
// types "continue".
//
// # Why the decision and the emission are separate functions
//
// The park suppresses the TaskCompleteEvent, and on this backend that event is
// the sole carrier of the run's cost and usage. The cost is delta-normalized
// against a per-CLI-session cumulative baseline that the result handler
// advances, so a park taken AFTER the baseline moved would drop the turn's
// spend from this run and from every later delta — permanently, because the
// woken run's cumulative is measured from the advanced mark.
//
// The result handler therefore asks for the decision first, skips the baseline
// advance when the answer is "park", and emits the suspend at the end — after
// the plan-mode and question handlers, which have side effects of their own
// (PlanProposalEvent, run.planCaptured) that a park must not skip.

// delegatedParkDecision reports whether this run's completion should become a
// park, and what it is waiting on.
//
// Nil seams mean "this run has no outstanding notion" and the park never fires,
// which is exactly how every consumer behaved before the seams existed.
func (b *ClaudeCodeBackend) delegatedParkDecision(run *claudeCodeRun, opts types.RunOptions) (parking bool, tasks, polls []string) {
	tasks = outstandingFromSeam(opts.OutstandingBackgroundTasks)
	polls = outstandingFromSeam(opts.OutstandingPolls)
	if len(tasks) == 0 && len(polls) == 0 {
		// The negative branch is logged too: the decision not to park is as
		// reconstructible from the log as the decision to park, and an absent
		// line here would be indistinguishable from a run that never reached
		// the turn boundary at all.
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "turn boundary: nothing outstanding, completing", map[string]any{
			"run_id": run.requestID,
		})
		return false, nil, nil
	}
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "turn boundary: background work outstanding, will park", map[string]any{
		"run_id":   run.requestID,
		"count":    len(tasks) + len(polls),
		"task_ids": tasks,
		"poll_ids": polls,
	})
	return true, tasks, polls
}

// emitDelegatedPark emits the TaskSuspendEvent that stands in for the run's
// completion. The caller must NOT emit the TaskCompleteEvent afterwards.
//
// The run's exit is deliberately left to the normal process-exit path rather
// than emitted here. On the API backend the park has to emit an exit explicitly
// because the run loop is returning early from a live goroutine; here the
// subprocess is already on its way out and runProcess emits the exit
// unconditionally a few lines later. Emitting a second one would unbind the run
// twice.
func (b *ClaudeCodeBackend) emitDelegatedPark(run *claudeCodeRun, tasks, polls []string) {
	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "parking run: background work still outstanding", map[string]any{
		"run_id":   run.requestID,
		"count":    len(tasks) + len(polls),
		"task_ids": tasks,
		"poll_ids": polls,
	})
	b.emit(run.requestID, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
		AwaitingTaskIDs: tasks,
		AwaitingPollIDs: polls,
	}})
}

// outstandingFromSeam reads a live outstanding set through its seam, tolerating
// a nil seam.
func outstandingFromSeam(seam func() []string) []string {
	if seam == nil {
		return nil
	}
	return seam()
}
