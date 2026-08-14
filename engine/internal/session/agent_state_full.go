package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// GetAgentState returns an explicit full-fidelity roster to a command caller.
// It does not emit an EngineEvent: Manager events broadcast to every attached
// consumer, which would recreate the oversized-payload fan-out the bounded
// engine_agent_state broadcast prevents.
func (m *Manager) GetAgentState(key string) []types.AgentStateUpdate {
	m.mu.RLock()
	var states []types.AgentStateUpdate
	if session, ok := m.sessions[key]; ok {
		states = session.agents.FullMergedSnapshot()
	}
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelInfo, "session", "agent_state_full_returned", map[string]any{
		"key": key, "count": len(states),
	})
	return states
}
