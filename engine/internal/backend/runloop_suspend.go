package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// suspendSignal is the value sent on activeRun.suspendCh when an extension
// calls ctx.suspend() or ctx.suspendUntilAll(). AwaitingDispatchIDs lists
// the child dispatch IDs the agent is waiting on; empty means bare suspend()
// (the dispatch revives on the next sendPrompt to this session).
type suspendSignal struct {
	AwaitingDispatchIDs []string
	// AwaitingTaskIDs lists the background bash task IDs a session is parked
	// on. Set by the turn-boundary park path (parkForBackgroundTasks), not by
	// the extension RPC. Carried on the same signal type because both express
	// "this run ended without completing, and something will revive it."
	AwaitingTaskIDs []string
	// AwaitingPollIDs lists inference-driven polls holding a root session open.
	AwaitingPollIDs []string
}

// drainSuspend performs a non-blocking check of the run's suspendCh. When a
// suspend signal is present it emits TaskSuspendEvent, emits the run's exit
// with the distinct "suspended" signal, and returns (true, signal). The
// caller (runLoop) should exit immediately after, without calling the normal
// TaskCompleteEvent path — the dispatch stays alive and runChild loops to
// restart the LLM run on revive.
//
// The exit emission is REQUIRED, not optional, on both suspend consumers:
//
//   - A dispatched child's runChild goroutine waits on childDone, which is
//     released only by the child backend's OnExit callback
//     (session/extcontext/dispatch_agent.go). Without the exit, runChild
//     blocks forever before it can observe the suspend and park — the
//     original wiring omitted it and the suspend feature deadlocked.
//   - A root session parked via ParkSelfMainLoop → SignalParkForBackgroundTasks
//     needs handleRunExit to clear the session's requestID, exactly as the
//     automatic parkForBackgroundTasks path does; without it the parked
//     session still looks busy and the wake path steers into a dead run.
//
// The signal string "suspended" distinguishes a park-exit from a completion
// (nil) and a cancellation ("cancelled") so exit consumers can branch.
// Returns (false, {}) when no suspend is pending.
//
// Call sites mirror drainSteer:
//   - Top of each agent-loop iteration: catches a suspend that arrived while
//     the previous turn was in flight.
//   - Before the end_turn/stop exit: gives the extension a chance to suspend
//     cleanly instead of completing the dispatch.
func (b *ApiBackend) drainSuspend(run *activeRun, conv *conversation.Conversation) (bool, suspendSignal) {
	select {
	case sig := <-run.suspendCh:
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "suspend signal received, emitting task_suspend and exiting run", map[string]any{
			"run_id":                run.requestID,
			"awaiting_dispatch_ids": sig.AwaitingDispatchIDs,
			"awaiting_task_ids":     sig.AwaitingTaskIDs,
			"awaiting_poll_ids":     sig.AwaitingPollIDs,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
			AwaitingDispatchIDs: sig.AwaitingDispatchIDs,
			AwaitingTaskIDs:     sig.AwaitingTaskIDs,
			AwaitingPollIDs:     sig.AwaitingPollIDs,
		}})
		b.emitExit(run.requestID, intPtr(0), strPtr("suspended"), conv.ID)
		return true, sig
	default:
		return false, suspendSignal{}
	}
}

// parkForBackgroundTasks ends the run at a turn boundary because the session
// still has outstanding background bash commands. It emits TaskSuspendEvent
// carrying the task IDs, then emits the run's exit so the session layer runs
// its normal terminal bookkeeping. The caller exits the run loop WITHOUT
// emitting TaskCompleteEvent — the work is not finished, it is merely no
// longer occupying a turn.
//
// This is what lets an orchestrator keep working and then go idle: the model
// ends its turn naturally, and the engine — not the model, and not a flag on
// the tool call — decides to hold the session open because work is in flight.
// The session layer records the park (markSessionParked) off the emitted
// event and revives the session by starting a new run when a command
// completes.
//
// The exit emission is LOAD-BEARING, not bookkeeping hygiene. handleRunExit is
// what clears engineSession.requestID and unbinds the run key, and the wake
// path reads exactly that state to decide whether an arriving completion should
// be steered into a live run or should wake a parked session. Without the exit
// a parked session still looks busy: a completion arriving while parked takes
// the steer branch, lands on a run that has already returned, and the result is
// silently dropped — the session is never woken for it. The park is reported as
// a clean exit (code 0, no signal) because that is what it is: the run ended
// deliberately, the conversation is intact, and the session is immediately
// reusable. The suspend paths (drainSuspend, parkForChildDispatches) emit
// their exits with the distinct "suspended" signal for the same load-bearing
// reason — a dispatched child's runChild goroutine waits on the child
// backend's OnExit, and a root ParkSelfMainLoop park needs handleRunExit —
// while the signal string lets exit consumers tell a park from a completion.
func (b *ApiBackend) parkForBackgroundTasks(run *activeRun, conv *conversation.Conversation, taskIDs, pollIDs []string) {
	// Persist first: the woken run reloads the conversation from disk, so an
	// unsaved final turn would be lost across the park.
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "failed to save conversation before background-task park", map[string]any{
			"run_id": run.requestID,
			"error":  utils.ErrStr(err),
		})
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "parking run: background commands still outstanding", map[string]any{
		"run_id":   run.requestID,
		"count":    len(taskIDs) + len(pollIDs),
		"task_ids": taskIDs,
		"poll_ids": pollIDs,
	})
	b.emit(run, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
		AwaitingTaskIDs: taskIDs,
		AwaitingPollIDs: pollIDs,
	}})
	// Terminal bookkeeping, ordered AFTER the suspend event so the session
	// records the park before it processes the exit.
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// outstandingBackgroundTaskIDs reads the run's live outstanding background
// commands through the RunConfig seam. A live read (not a snapshot taken at
// run start) because the model may start more commands DURING the run, and
// the park decision at the turn boundary must see them.
func (b *ApiBackend) outstandingBackgroundTaskIDs(run *activeRun) []string {
	if run.cfg == nil || run.cfg.OutstandingBackgroundTasks == nil {
		return nil
	}
	return run.cfg.OutstandingBackgroundTasks()
}

func (b *ApiBackend) outstandingPollIDs(run *activeRun) []string {
	if run.cfg == nil || run.cfg.OutstandingPolls == nil {
		return nil
	}
	return run.cfg.OutstandingPolls()
}

// outstandingChildDispatchIDs reads the run's live outstanding child
// dispatches through the RunConfig seam — the child-dispatch analogue of
// outstandingBackgroundTaskIDs. A live read for the same reason: the model
// dispatches agents DURING the run, so the park decision at the turn
// boundary must see the current set. Nil config or nil seam means "this run
// has no child-dispatch notion" (root sessions, tests, pre-existing
// consumers) and the child park never fires.
func (b *ApiBackend) outstandingChildDispatchIDs(run *activeRun) []string {
	if run.cfg == nil || run.cfg.OutstandingChildDispatches == nil {
		return nil
	}
	return run.cfg.OutstandingChildDispatches()
}

// parkForChildDispatches ends the current LLM run at a turn boundary because
// the run still has child dispatches in flight. It emits TaskSuspendEvent
// carrying the child dispatch IDs, then the run's exit with the "suspended"
// signal — deliberately the exact emission sequence drainSuspend produces for
// an extension-driven ctx.suspend(), so the two park entrances are
// indistinguishable to the consumer that matters:
//
// A dispatched child's park is owned by its runChild goroutine
// (session/extcontext/dispatch_agent.go). runChild observes the
// TaskSuspendEvent (setting its suspend flag), then blocks on childDone,
// which is released ONLY by the child backend's OnExit callback. The exit
// emission is therefore load-bearing here exactly as it is in drainSuspend:
// without it runChild never wakes to park the dispatch. The child backend's
// OnExit is wired to the runChild closure — not to the session manager's
// handleRunExit — so this exit cannot be mistaken for a root-session
// terminal event.
//
// The conversation is saved first so the revived run — which reloads from
// disk — sees the final turn that decided to park.
func (b *ApiBackend) parkForChildDispatches(run *activeRun, conv *conversation.Conversation, dispatchIDs []string) {
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "failed to save conversation before child-dispatch park", map[string]any{
			"run_id": run.requestID,
			"error":  utils.ErrStr(err),
		})
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "parking run: child dispatches still outstanding", map[string]any{
		"run_id":       run.requestID,
		"count":        len(dispatchIDs),
		"dispatch_ids": dispatchIDs,
	})
	b.emit(run, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
		AwaitingDispatchIDs: dispatchIDs,
	}})
	b.emitExit(run.requestID, intPtr(0), strPtr("suspended"), conv.ID)
}

// SignalParkForBackgroundTasks asks an active run to park on the given
// background bash task IDs. Used by the extension-facing depth-0 ctx.Suspend
// path; the engine's own turn-boundary park calls parkForBackgroundTasks
// directly on the run it already holds.
//
// Reuses the run's suspendCh (buffered, cap 1) exactly as SignalSuspend does,
// so the park is drained at the next turn boundary rather than interrupting an
// in-flight provider call. Returns false when no run matches the requestID or
// a suspend is already queued.
func (b *ApiBackend) SignalParkForBackgroundTasks(requestID string, taskIDs []string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "signalpark: no active run for requestID", map[string]any{"run_id": requestID})
		return false
	}
	select {
	case run.suspendCh <- suspendSignal{AwaitingTaskIDs: taskIDs}:
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "signalpark: park signal queued", map[string]any{"run_id": requestID, "count": len(taskIDs)})
		return true
	default:
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "signalpark: suspendCh full, park signal dropped", map[string]any{"run_id": requestID})
		return false
	}
}

// SignalSuspend sends a suspend signal on the run's suspendCh. Called by the
// ext/task_suspend RPC handler. Non-blocking (buffered cap 1); if the channel
// is already full, the existing signal is not replaced (first-write-wins).
// Returns true when delivered, false when the channel was full (indicating the
// extension already requested a suspend on this run) or when no run matches.
func (b *ApiBackend) SignalSuspend(requestID string, awaitingDispatchIDs []string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "signalsuspend: no active run for requestID", map[string]any{"run_id": requestID})
		return false
	}
	select {
	case run.suspendCh <- suspendSignal{AwaitingDispatchIDs: awaitingDispatchIDs}:
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "signalsuspend: suspend signal queued", map[string]any{"run_id": requestID, "awaiting": len(awaitingDispatchIDs)})
		return true
	default:
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "signalsuspend: suspendCh full, signal dropped", map[string]any{"run_id": requestID})
		return false
	}
}
