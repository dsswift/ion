package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// emitSessionStatus publishes the current authoritative session snapshot after
// work inventory changes outside a normal run boundary.
func (m *Manager) emitSessionStatus(key, reason string) {
	fields, ok := m.buildStatusFields(key)
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "emitSessionStatus: session absent", map[string]any{
			"session_id": key, "reason": reason,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "emitSessionStatus", map[string]any{
		"session_id":        key,
		"reason":            reason,
		"state":             fields.State,
		"background_agents": fields.BackgroundAgents,
		"background_shells": fields.BackgroundShells,
		"has_pending_work":  fields.HasPendingWork,
	})
	m.emit(key, types.EngineEvent{Type: "engine_status", Fields: fields})
}

// emitDispatchCountStatus follows a dispatch deregistration with a fresh
// agent-state snapshot. The status is not hard-coded idle: a root run may still
// be live while a child count changes.
func (m *Manager) emitDispatchCountStatus(s *engineSession, reason string) {
	fields, ok := m.buildStatusFields(s.key)
	if !ok {
		return
	}
	m.mu.RLock()
	latest := m.sessions[s.key]
	var snapshot []types.AgentStateUpdate
	if latest != nil {
		snapshot = latest.agents.MergedSnapshot()
	}
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelInfo, "session", "emitDispatchCountStatus", map[string]any{
		"session_id":        s.key,
		"reason":            reason,
		"state":             fields.State,
		"background_agents": fields.BackgroundAgents,
		"background_shells": fields.BackgroundShells,
		"has_pending_work":  fields.HasPendingWork,
	})
	m.emit(s.key, types.EngineEvent{Type: "engine_status", Fields: fields})
	m.emitAgentSnapshot(s.key, agentSnapshotReasonDispatchCount, true, snapshot)
}
