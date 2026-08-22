package extcontext

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetSuspendedState parks a dispatch as suspended, arming it for revival.
// reviveCh is the channel runChild blocks on; a send on it causes the loop to
// restart the LLM run. pendingChildIDs is the set of child dispatch IDs the
// agent is waiting on (empty for bare suspend() — revives on the next
// sendPrompt regardless of origin).
//
// Pending IDs are pruned against the entry's already-recorded child results:
// a child that completed in the window between the parent's park emission and
// this arming has already fired its NotifyChildComplete (a no-op — ReviveCh
// was nil) and will never notify again, so counting it as pending would park
// the parent forever. Returns false when the prune empties a non-empty
// pending set — the wait is already satisfied and the caller must revive
// immediately instead of blocking. Returns true when the dispatch is parked
// (or unknown, the historical no-op). Thread-safe.
func (r *DispatchRegistry) SetSuspendedState(id string, reviveCh chan struct{}, pendingChildIDs []string) bool {
	return r.SetSuspendedStateWithWaitingOn(id, reviveCh, pendingChildIDs, nil)
}

// SetSuspendedStateWithWaitingOn parks a dispatch with its complete async wait
// set. Child IDs and task IDs come from the run's TaskSuspendEvent.
//
// Both halves are pruned against work that already settled in the window
// between the park emission and this arming: children against the entry's
// recorded results, tasks against the registry's settled-task table (a
// completion that arrived before any dispatch awaited it — see
// dispatch_task_revive.go). A settled task's result is moved onto the entry so
// the immediate revive still carries it. Returns false when the prune empties
// a non-empty wait set, meaning the caller must revive immediately rather than
// park on work that will never notify again.
func (r *DispatchRegistry) SetSuspendedStateWithWaitingOn(id string, reviveCh chan struct{}, pendingChildIDs, pendingTaskIDs []string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "setsuspendedstate: dispatch not found (no-op)", map[string]any{"run_id": id})
		return true
	}

	awaitedAny := len(pendingChildIDs) > 0 || len(pendingTaskIDs) > 0

	// Prune children that already completed (their results are recorded on
	// this entry); they will never notify again.
	if len(pendingChildIDs) > 0 && len(d.CompletedChildResults) > 0 {
		done := make(map[string]struct{}, len(d.CompletedChildResults))
		for _, rec := range d.CompletedChildResults {
			done[rec.ChildID] = struct{}{}
		}
		pruned := pendingChildIDs[:0:0]
		for _, cid := range pendingChildIDs {
			if _, completed := done[cid]; completed {
				utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "setsuspendedstate: pending child already completed, pruned", map[string]any{"run_id": id, "reason": cid})
				continue
			}
			pruned = append(pruned, cid)
		}
		pendingChildIDs = pruned
	}

	// Prune background tasks that completed before this arming. Their results
	// move onto the entry so an immediate revive is not blind.
	if len(pendingTaskIDs) > 0 {
		pruned := pendingTaskIDs[:0:0]
		for _, taskID := range pendingTaskIDs {
			if rec, settled := r.takeSettledTaskLocked(taskID); settled {
				d.CompletedTaskResults = append(d.CompletedTaskResults, rec)
				utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "setsuspendedstate: pending task already completed, pruned", map[string]any{"run_id": id, "task_id": taskID, "exit_code": rec.ExitCode})
				continue
			}
			pruned = append(pruned, taskID)
		}
		pendingTaskIDs = pruned
	}

	if awaitedAny && len(pendingChildIDs) == 0 && len(pendingTaskIDs) == 0 {
		// Everything awaited already finished: the park is already satisfied.
		// Do not arm; the caller revives immediately.
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "setsuspendedstate: all awaited work already complete, immediate revive", map[string]any{"run_id": id})
		return false
	}

	d.ReviveCh = reviveCh
	d.Suspended = true
	if len(pendingChildIDs) > 0 {
		d.PendingChildren = make(map[string]struct{}, len(pendingChildIDs))
		for _, cid := range pendingChildIDs {
			d.PendingChildren[cid] = struct{}{}
		}
	} else {
		d.PendingChildren = nil
	}
	if len(pendingTaskIDs) > 0 {
		d.PendingTasks = make(map[string]struct{}, len(pendingTaskIDs))
		for _, taskID := range pendingTaskIDs {
			d.PendingTasks[taskID] = struct{}{}
		}
	} else {
		d.PendingTasks = nil
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "setsuspendedstate: dispatch parked", map[string]any{"run_id": id, "count": len(pendingChildIDs), "awaiting_tasks": len(pendingTaskIDs)})
	return true
}

// ClearSuspendedState removes the suspend state from a dispatch entry after
// the revive signal fires and runChild resumes. Called by runChild before
// starting the next LLM run so the entry is clean if the agent suspends again.
func (r *DispatchRegistry) ClearSuspendedState(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		return
	}
	d.ReviveCh = nil
	d.PendingChildren = nil
	d.PendingTasks = nil
	d.Suspended = false
}

// NotifyChildComplete removes childID from a suspended dispatch's pending set.
// If the set becomes empty (or was already nil — bare suspend), the ReviveCh
// is signaled and the channel pointer is cleared. Returns true when a signal
// was sent. Thread-safe.
func (r *DispatchRegistry) NotifyChildComplete(dispatchID, childID string) bool {
	r.mu.Lock()

	d, ok := r.dispatches[dispatchID]
	if !ok {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "notifychildcomplete: dispatch not found (no-op)", map[string]any{"run_id": dispatchID, "reason": childID})
		return false
	}

	if d.ReviveCh == nil {
		// Not suspended — nothing to notify.
		r.mu.Unlock()
		return false
	}

	if d.PendingChildren != nil {
		delete(d.PendingChildren, childID)
		if len(d.PendingChildren) > 0 {
			// Still waiting on other children.
			remaining := len(d.PendingChildren)
			r.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "notifychildcomplete: child done, still waiting", map[string]any{"run_id": dispatchID, "reason": childID, "count": remaining})
			return false
		}
	}

	// A mixed park (children AND background commands) is not satisfied by the
	// children alone. Reviving here would resume the agent while its own shell
	// commands are still running, and DeliverTaskResult would then find an
	// unarmed entry — the same lost-wake shape this half already fixes.
	if len(d.PendingTasks) > 0 {
		remainingTasks := len(d.PendingTasks)
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "notifychildcomplete: children done, still waiting on background commands", map[string]any{"run_id": dispatchID, "reason": childID, "awaiting_tasks": remainingTasks})
		return false
	}

	// All pending children done (or bare suspend): signal revive.
	ch := d.ReviveCh
	d.ReviveCh = nil
	d.PendingChildren = nil
	r.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "notifychildcomplete: all children done, signalling revive", map[string]any{"run_id": dispatchID, "reason": childID})
	select {
	case ch <- struct{}{}:
	default:
		// Already signaled (should not happen in normal operation).
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "notifychildcomplete: revive channel full or closed", map[string]any{"run_id": dispatchID})
	}
	return true
}

// SignalReviveForSession signals the reviveCh of EVERY suspended dispatch
// whose session ID matches sessionID and whose park is a bare suspend
// (PendingChildren nil). This is the hook that sendPrompt calls after
// queueing a new user message on a session that may host suspended
// dispatches. For bare suspend() calls the revive fires immediately because
// the new message is already in the conversation; fan-out parks
// (PendingChildren non-nil) are deliberately skipped — only
// NotifyChildComplete may drive those. Returns true when at least one
// dispatch was signalled. All matches are woken (not just the first): two
// bare-parked dispatches on one session must both see the prompt, and
// leaving one parked strands it until timeout. Thread-safe.
func (r *DispatchRegistry) SignalReviveForSession(sessionID string) bool {
	r.mu.Lock()

	var matched []*activeDispatch
	var channels []chan struct{}
	for _, d := range r.dispatches {
		if d.SessionID == sessionID && d.ReviveCh != nil && d.PendingChildren == nil {
			matched = append(matched, d)
			channels = append(channels, d.ReviveCh)
			d.ReviveCh = nil
		}
	}
	r.mu.Unlock()

	if len(matched) == 0 {
		return false
	}

	for i, d := range matched {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "signalreviveforsession: reviving suspended dispatch", map[string]any{"run_id": d.ID, "model": d.Name, "session_id": sessionID, "count": len(matched)})
		select {
		case channels[i] <- struct{}{}:
		default:
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "signalreviveforsession: revive channel full", map[string]any{"run_id": d.ID})
		}
	}
	return true
}
