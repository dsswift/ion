package extcontext

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_task_revive.go is the background-bash half of the parked-dispatch
// revive machinery. The child half lives in dispatch_registry_suspend.go
// (NotifyChildComplete) and dispatch_park.go (the resume prompt).
//
// A dispatched agent that starts a background bash command and then suspends
// parks on PendingTasks. Background-task ownership is session-scoped (the
// tools layer records the ROOT session key as the task's owner), so the
// completion notification arrives at the session layer, not at the dispatch.
// Before this file existed the session layer removed the task id from the
// dispatch's wait set and then delivered the result to the ROOT run — the
// parked dispatch itself was never signalled, its revive select had no
// timeout, and the only escape was a recall. Every ancestor waiting on that
// dispatch stayed parked with it. DeliverTaskResult closes that hole: it
// records the result on the owning dispatch and signals ReviveCh exactly the
// way NotifyChildComplete does when the wait set drains.

// maxTaskResultLen caps a recorded task payload the same way maxChildResultLen
// caps a child's output: the record is injected into a prompt, so an
// unbounded tail from a chatty command would crowd out the conversation.
const maxTaskResultLen = 48 * 1024

// maxSettledTasks bounds the pre-arm settled-task table. It only ever holds
// completions that raced a park arming, so the live set is tiny; the cap
// exists so a long-lived session cannot grow the map without limit.
const maxSettledTasks = 256

// TaskResultRecord is a completed background bash command's outcome as the
// parked dispatch that started it needs to read it. Payload is the rendered
// completion text the session layer already builds for its own wake prompt,
// reused verbatim so a dispatch and the root see the same words for the same
// event.
type TaskResultRecord struct {
	TaskID   string
	Status   string
	ExitCode int
	Payload  string
}

// truncated returns the record with Payload clamped to maxTaskResultLen.
func (rec TaskResultRecord) truncated() TaskResultRecord {
	if len(rec.Payload) > maxTaskResultLen {
		rec.Payload = rec.Payload[:maxTaskResultLen] + "\n[truncated]"
	}
	return rec
}

// DeliverTaskResult routes a completed background bash command to the parked
// dispatch that is waiting on it, and revives that dispatch when the
// completion empties its wait set.
//
// Returns the owning dispatch id (empty when no parked dispatch awaits this
// task — the session layer then delivers to the root as before) and whether a
// revive signal was sent. A non-empty owner with revived=false means the
// dispatch is still waiting on other work; the result is recorded and will be
// injected by the revive that eventually fires.
//
// A completion for a task no dispatch is waiting on is remembered in the
// settled table, because the dispatch may not have armed its wait yet: the
// park emission and SetSuspendedStateWithWaitingOn are not atomic, and a fast
// command can finish in between. The arming prune consumes it. Thread-safe.
func (r *DispatchRegistry) DeliverTaskResult(taskID string, rec TaskResultRecord) (string, bool) {
	rec.TaskID = taskID
	rec = rec.truncated()

	r.mu.Lock()

	var owner *activeDispatch
	for _, d := range r.dispatches {
		if _, waiting := d.PendingTasks[taskID]; waiting {
			owner = d
			break
		}
	}

	if owner == nil {
		r.rememberSettledTaskLocked(rec)
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "delivertaskresult: no parked dispatch awaits this task; recorded as settled", map[string]any{
			"task_id": taskID, "status": rec.Status, "exit_code": rec.ExitCode,
		})
		return "", false
	}

	delete(owner.PendingTasks, taskID)
	owner.CompletedTaskResults = append(owner.CompletedTaskResults, rec)
	dispatchID := owner.ID
	remainingTasks := len(owner.PendingTasks)
	remainingChildren := len(owner.PendingChildren)

	if owner.ReviveCh == nil || remainingTasks > 0 || remainingChildren > 0 {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "delivertaskresult: task recorded on dispatch, wait set not empty", map[string]any{
			"run_id": dispatchID, "task_id": taskID, "count": remainingTasks,
			"awaiting_children": remainingChildren, "armed": owner.ReviveCh != nil,
		})
		return dispatchID, false
	}

	ch := owner.ReviveCh
	owner.ReviveCh = nil
	owner.PendingTasks = nil
	r.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "delivertaskresult: wait set drained, signalling revive", map[string]any{
		"run_id": dispatchID, "task_id": taskID, "status": rec.Status, "exit_code": rec.ExitCode,
	})
	select {
	case ch <- struct{}{}:
	default:
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "delivertaskresult: revive channel full or closed", map[string]any{
			"run_id": dispatchID, "task_id": taskID,
		})
	}
	return dispatchID, true
}

// rememberSettledTaskLocked stores a completion that no dispatch was waiting
// on, evicting the oldest entry once the table is full. Caller holds r.mu.
func (r *DispatchRegistry) rememberSettledTaskLocked(rec TaskResultRecord) {
	if r.settledTasks == nil {
		r.settledTasks = make(map[string]TaskResultRecord)
	}
	if _, exists := r.settledTasks[rec.TaskID]; !exists {
		r.settledOrder = append(r.settledOrder, rec.TaskID)
	}
	r.settledTasks[rec.TaskID] = rec
	for len(r.settledOrder) > maxSettledTasks {
		evicted := r.settledOrder[0]
		r.settledOrder = r.settledOrder[1:]
		delete(r.settledTasks, evicted)
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "settled task table full, evicting oldest", map[string]any{
			"task_id": evicted, "count": len(r.settledOrder),
		})
	}
}

// takeSettledTaskLocked consumes a settled completion for taskID, if one is
// held. Caller holds r.mu.
func (r *DispatchRegistry) takeSettledTaskLocked(taskID string) (TaskResultRecord, bool) {
	rec, ok := r.settledTasks[taskID]
	if !ok {
		return TaskResultRecord{}, false
	}
	delete(r.settledTasks, taskID)
	for i, id := range r.settledOrder {
		if id == taskID {
			r.settledOrder = append(r.settledOrder[:i], r.settledOrder[i+1:]...)
			break
		}
	}
	return rec, true
}

// DrainTaskResults removes and returns the recorded background-task results
// for a dispatch. Called by runChild on revive so the resume prompt carries
// the command outcomes. Thread-safe.
func (r *DispatchRegistry) DrainTaskResults(id string) []TaskResultRecord {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok || len(d.CompletedTaskResults) == 0 {
		return nil
	}
	out := d.CompletedTaskResults
	d.CompletedTaskResults = nil
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "draintaskresults: drained background task results", map[string]any{
		"run_id": id, "count": len(out),
	})
	return out
}

// PendingTaskOwner reports the dispatch id parked on taskID, or "" when no
// parked dispatch awaits it. Read-only; used for observability and by tests.
func (r *DispatchRegistry) PendingTaskOwner(taskID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, d := range r.dispatches {
		if _, waiting := d.PendingTasks[taskID]; waiting {
			return d.ID
		}
	}
	return ""
}

// dispatchParkTimeout resolves the ceiling a parked dispatch waits before it
// gives up and goes terminal. It reuses backgroundTasks.parkTimeoutMs — the
// same operator-configurable value that bounds a root session's park — rather
// than inventing a second constant for the same opinion. A nil config resolves
// to the compiled default (30 minutes).
//
// The ceiling is a backstop, not the mechanism: the revive signal is what
// normally releases the park. It exists because before it, a lost or misrouted
// wake left the dispatch blocked on reviveCh with no escape but a recall, and
// every ancestor parked on that dispatch was stranded with it — an eternal
// park that no log line ever reported as a failure.
func dispatchParkTimeout(sa SessionAccessor) time.Duration {
	var cfg *types.BackgroundTasksConfig
	if sa != nil {
		if ec := sa.EngineConfig(); ec != nil {
			cfg = ec.BackgroundTasks
		}
	}
	return time.Duration(cfg.Resolved().ParkTimeoutMs) * time.Millisecond
}

// reviveKindWithTasks classifies a revive that carries background-task
// results. Child results dominate when both are present: the awaited children
// are the stronger provenance signal, and the task results ride along in the
// same prompt.
func reviveKindWithTasks(children []ChildResultRecord, tasks []TaskResultRecord) string {
	if len(children) > 0 {
		return reviveInjectionKind(children)
	}
	if len(tasks) > 0 {
		return string(types.InjectionKindBackgroundTaskCompletion)
	}
	return reviveInjectionKind(children)
}

// buildReviveResumePromptWith composes the revive prompt for a park that may
// have waited on children, background commands, or both. The child section is
// buildReviveResumePrompt verbatim; the task section is appended after it.
func buildReviveResumePromptWith(children []ChildResultRecord, tasks []TaskResultRecord) string {
	if len(tasks) == 0 {
		return buildReviveResumePrompt(children)
	}

	var b strings.Builder
	if len(children) > 0 {
		b.WriteString(buildReviveResumePrompt(children))
		b.WriteString("\n")
	} else if len(tasks) == 1 {
		b.WriteString("[SYSTEM] The background command you were waiting on has finished. Its result is below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n")
	} else {
		fmt.Fprintf(&b, "[SYSTEM] All %d background commands you were waiting on have finished. Their results are below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n", len(tasks))
	}
	for _, t := range tasks {
		fmt.Fprintf(&b, "\n--- [background command %s] %s (exit %d) ---\n%s\n", t.TaskID, t.Status, t.ExitCode, t.Payload)
	}
	return b.String()
}
