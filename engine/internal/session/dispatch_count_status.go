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
	var pct, cw, tokens int
	var model string
	var runCost, convCost float64
	var sessionID string
	var shellCount int
	if s2, ok := m.sessions[key]; ok {
		pct = s2.lastContextPct
		cw = s2.lastContextWindow
		tokens = s2.lastContextTokens
		model = s2.lastModel
		runCost = s2.lastTotalCost
		convCost = s2.lastConvCost
		sessionID = s2.conversationID
		// Outstanding background shells are read live here, alongside the
		// dispatch count, so an idle session that is holding for background
		// commands reports them on the same status event.
		shellCount = len(s2.outstandingBackgroundTasks)
	}
	m.mu.RUnlock()
	return &types.StatusFields{
		Label: key, State: "idle", SessionID: sessionID,
		ContextPercent: pct, ContextWindow: cw, ContextTokens: tokens,
		Model: model, RunCostUsd: runCost, ConversationCostUsd: convCost,
		BackgroundAgents: bgCount,
		BackgroundShells: shellCount,
	}
}

// emitSessionStatus emits a corrected engine_status for the session using the
// shared idle-status projection. Used by the background-task registry when the
// outstanding-shell count changes outside a run-exit or dispatch-deregister
// boundary (a command started mid-turn, or a completion drained the set), so
// consumers never render a stale count.
func (m *Manager) emitSessionStatus(key, reason string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var bgCount int
	if ok && s.dispatchRegistry != nil {
		bgCount = len(s.dispatchRegistry.ActiveIDs())
	}
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "emitsessionstatus: no such session", map[string]any{"key": key, "reason": reason})
		return
	}

	fields := m.buildIdleStatusFields(s, key, bgCount)
	utils.LogWithFields(utils.LevelDebug, "session", "emitsessionstatus", map[string]any{
		"key": key, "reason": reason, "bg_count": bgCount, "shell_count": fields.BackgroundShells,
	})
	m.emit(key, types.EngineEvent{Type: "engine_status", Fields: fields})
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
	// force=true: this fires on dispatch-count transitions, which are the
	// structural changes consumers drive their spinner and counter off. It
	// pairs with the engine_status emitted immediately above, and letting the
	// two diverge in timing would show a count that disagrees with the roster.
	m.emitAgentSnapshot(key, agentSnapshotReasonDispatchCount, true, snapshot)
}
