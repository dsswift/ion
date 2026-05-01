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
// clears the registry. Called when the parent run dies (error/non-zero
// exit) or the user interrupts so dispatched agents do not continue
// running standalone and burning model budget.
func (m *Manager) abortAllDescendants(key, reason string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	var pids []int
	var names []string
	for name, handle := range s.agentRegistry {
		pids = append(pids, handle.PID)
		names = append(names, name)
	}
	s.agentRegistry = map[string]types.AgentHandle{}
	hasExt := s.extGroup != nil && !s.extGroup.IsEmpty()
	m.mu.Unlock()

	if len(pids) == 0 {
		return
	}
	utils.Warn("Session", fmt.Sprintf("aborting %d descendant agent(s) (%s): key=%s names=%v", len(pids), reason, key, names))
	for _, pid := range pids {
		killProcess(pid)
	}
	// Emit cleared agent state so the UI panel updates. Skip when the
	// session has an extension group — extensions own their agent panel
	// and will publish their own snapshot.
	if !hasExt {
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: []types.AgentStateUpdate{},
		})
	}
}
