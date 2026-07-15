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
}

// drainSuspend performs a non-blocking check of the run's suspendCh. When a
// suspend signal is present it emits TaskSuspendEvent and returns
// (true, signal). The caller (runLoop) should exit immediately after, without
// calling the normal TaskCompleteEvent path — the dispatch stays alive and
// runChild loops to restart the LLM run on revive. Returns (false, {}) when
// no suspend is pending.
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
		})
		b.emit(run, types.NormalizedEvent{Data: &types.TaskSuspendEvent{
			AwaitingDispatchIDs: sig.AwaitingDispatchIDs,
		}})
		return true, sig
	default:
		return false, suspendSignal{}
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
