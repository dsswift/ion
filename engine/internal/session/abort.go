package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SendAbort cancels the active run for the given session and reaps any
// dispatched child agents so they do not continue running standalone.
func (m *Manager) SendAbort(key string) {
	utils.Info("Session", fmt.Sprintf("SendAbort: key=%s", key))
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Warn("Session", fmt.Sprintf("SendAbort: session not found for key=%s", key))
		return
	}
	rid := s.requestID
	m.mu.RUnlock()

	if rid != "" {
		utils.Info("Session", fmt.Sprintf("SendAbort: cancelling requestID=%s for key=%s", rid, key))
		m.backend.Cancel(rid)
	} else {
		utils.Warn("Session", fmt.Sprintf("SendAbort: no active requestID for key=%s (reaping descendants only)", key))
	}
	// Always reap descendants — they may outlive the parent run
	m.abortAllDescendants(key, "user abort")
}

// abortAllDescendants kills every agent registered for this session and
// transitions their engine-managed states to "cancelled" so the next
// emitted snapshot reflects reality. Called when the parent run dies
// (error/non-zero exit) or the user interrupts so dispatched agents do
// not continue running standalone and burning model budget.
//
// Engine contract: `engine_agent_state` events are complete snapshots.
// Every code path that ends an agent's run must transition the registry
// to a terminal status (done/error/cancelled) before emitting, so the
// next snapshot is authoritative. See docs/architecture/agent-state.md.
func (m *Manager) abortAllDescendants(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Warn("Session", fmt.Sprintf("abortAllDescendants: session not found key=%s reason=%s", key, reason))
		return
	}
	hasExt := s.extGroup != nil && !s.extGroup.IsEmpty()
	m.mu.RUnlock()

	pids, names := s.agents.ClearHandles()
	if len(pids) == 0 {
		utils.Debug("Session", fmt.Sprintf("abortAllDescendants: no handles to clear key=%s reason=%s", key, reason))
		return
	}

	utils.Warn("Session", fmt.Sprintf("aborting %d descendant agent(s) (%s): key=%s names=%v", len(pids), reason, key, names))
	for _, pid := range pids {
		killProcess(pid)
	}

	// Transition every engine-managed state for the killed handles to
	// "cancelled" so the snapshot we emit (and any subsequent reconcile)
	// reflects that these agents are no longer running. Without this,
	// MergedSnapshot() would still report them as running and a future
	// ReconcileState would re-broadcast stale rows.
	for _, name := range names {
		s.agents.UpdateState(name, func(state *types.AgentStateUpdate) {
			state.Status = "cancelled"
			if state.Metadata == nil {
				state.Metadata = map[string]interface{}{}
			}
			state.Metadata["lastWork"] = "cancelled: " + reason
		})
		utils.Log("Session", fmt.Sprintf("agent_terminated name=%s status=cancelled reason=%s key=%s", name, reason, key))
	}

	// Emit the authoritative snapshot. Skip only when the session has
	// an extension group — extensions own their agent panel and will
	// publish their own snapshot. Even then, the engine emits a
	// corrective snapshot on extension death (see handleHostDeath).
	if !hasExt {
		snapshot := s.agents.MergedSnapshot()
		utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=abort", key, len(snapshot)))
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: snapshot,
		})
	} else {
		utils.Debug("Session", fmt.Sprintf("abortAllDescendants: skipping engine snapshot — extension owns agent panel key=%s", key))
	}
}
