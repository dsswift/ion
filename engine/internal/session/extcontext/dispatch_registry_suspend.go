package extcontext

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetSuspendedState parks a dispatch as suspended, arming it for revival.
// reviveCh is the channel runChild blocks on; a send on it causes the loop to
// restart the LLM run. pendingChildIDs is the set of child dispatch IDs the
// agent is waiting on (empty for bare suspend() — revives on the next
// sendPrompt regardless of origin). Thread-safe.
func (r *DispatchRegistry) SetSuspendedState(id string, reviveCh chan struct{}, pendingChildIDs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "setsuspendedstate: dispatch not found (no-op)", map[string]any{"run_id": id})
		return
	}

	d.ReviveCh = reviveCh
	if len(pendingChildIDs) > 0 {
		d.PendingChildren = make(map[string]struct{}, len(pendingChildIDs))
		for _, cid := range pendingChildIDs {
			d.PendingChildren[cid] = struct{}{}
		}
	} else {
		d.PendingChildren = nil
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "setsuspendedstate: dispatch parked", map[string]any{"run_id": id, "count": len(pendingChildIDs)})
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

// SignalReviveForSession signals the reviveCh of any suspended dispatch whose
// session ID matches sessionID. This is the hook that sendPrompt calls after
// queueing a new user message on a session that may host a suspended dispatch.
// For bare suspend() calls (PendingChildren nil), the revive fires immediately
// because the new message is already in the conversation. Thread-safe.
func (r *DispatchRegistry) SignalReviveForSession(sessionID string) bool {
	r.mu.Lock()

	var matched *activeDispatch
	for _, d := range r.dispatches {
		if d.SessionID == sessionID && d.ReviveCh != nil && d.PendingChildren == nil {
			matched = d
			break
		}
	}

	if matched == nil {
		r.mu.Unlock()
		return false
	}

	ch := matched.ReviveCh
	matched.ReviveCh = nil
	r.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "signalreviveforsession: reviving suspended dispatch", map[string]any{"run_id": matched.ID, "model": matched.Name, "session_id": sessionID})
	select {
	case ch <- struct{}{}:
	default:
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "signalreviveforsession: revive channel full", map[string]any{"run_id": matched.ID})
	}
	return true
}
