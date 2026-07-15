package session

import (

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// buildIdleStatusFields returns the engine_status StatusFields block that
// every idle-state emission site uses. It reads the retained context/cost
// fields from the session under m.mu (caller must NOT hold the lock) and
// stamps the given bgCount directly — callers that have already computed the
// live count pass it in rather than recomputing.
//
// Both handleRunExit and emitDispatchCountStatus use this helper so the two
// emission sites stay field-identical.
func (m *Manager) buildIdleStatusFields(s *engineSession, key string, bgCount int) *types.StatusFields {
	m.mu.RLock()
	var pct, cw int
	var model string
	var runCost, convCost float64
	var sessionID string
	if s2, ok := m.sessions[key]; ok {
		pct = s2.lastContextPct
		cw = s2.lastContextWindow
		model = s2.lastModel
		runCost = s2.lastTotalCost
		convCost = s2.lastConvCost
		sessionID = s2.conversationID
	}
	m.mu.RUnlock()
	return &types.StatusFields{
		Label: key, State: "idle", SessionID: sessionID,
		ContextPercent: pct, ContextWindow: cw,
		Model: model, RunCostUsd: runCost, ConversationCostUsd: convCost,
		BackgroundAgents: bgCount,
	}
}

// emitDispatchCountStatus re-samples the live dispatch count from the session's
// registry and emits a corrected engine_status + engine_agent_state snapshot.
// Call this immediately after registry.Deregister so clients see the updated
// BackgroundAgents count rather than the stale value that handleRunExit stamped
// at run-exit time (before Deregister ran).
func (m *Manager) emitDispatchCountStatus(s *engineSession, reason string) {
	m.mu.RLock()
	key := s.key
	var bgCount int
	var snapshot []types.AgentStateUpdate
	if s2, ok := m.sessions[key]; ok {
		if s2.dispatchRegistry != nil {
			bgCount = len(s2.dispatchRegistry.ActiveIDs())
		}
		snapshot = s2.agents.MergedSnapshot()
	}
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelInfo, "session", "emitdispatchcountstatus", map[string]any{"key": key, "reason": reason, "bg_count": bgCount})

	fields := m.buildIdleStatusFields(s, key, bgCount)
	m.emit(key, types.EngineEvent{Type: "engine_status", Fields: fields})
	m.emit(key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})
}
