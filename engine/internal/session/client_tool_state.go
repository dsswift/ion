package session

// Client-tool pending-state owner — the session-side registry behind the
// engine_client_tool_state snapshot.
//
// The pending.Broker owns the reply CHANNELS (register/resolve/unregister,
// first-winner semantics). This file owns the reply METADATA: which client
// tool calls are currently blocked, with the facts a consumer needs to render
// or fulfill them after a reconnect (requestId, runId, tool name/input, cwd,
// humanWait). Every membership change emits a COMPLETE REPLACEMENT snapshot —
// the same contract as engine_agent_state (docs/architecture/agent-state.md):
// consumers replace their local view with the payload, and an empty array is
// the authoritative clear signal.
//
// Locking: the map lives on engineSession and is guarded by Manager.mu like
// the session's other maps. Emission happens after the lock is released
// (m.emit takes its own locks).

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// registerClientToolCall records one pending client-tool call and emits the
// updated snapshot. Called by requestClientToolResult after the broker
// channel is registered and before the request event is emitted, so a client
// that processes the request event can already see the call in a snapshot
// query.
func (m *Manager) registerClientToolCall(key string, call types.ClientToolCallState) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if ok {
		if s.pendingClientToolCalls == nil {
			s.pendingClientToolCalls = make(map[string]types.ClientToolCallState)
		}
		s.pendingClientToolCalls[call.RequestID] = call
	}
	m.mu.Unlock()
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool register skipped: session not found", map[string]any{"key": key, "gate_request_id": call.RequestID})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool call registered", map[string]any{
		"key": key, "gate_request_id": call.RequestID, "tool": call.ToolName, "run_id": call.RunID,
	})
	m.emitClientToolState(key)
}

// deregisterClientToolCall removes one pending client-tool call (response,
// timeout, cancellation — the caller logs which) and emits the updated
// snapshot, including the authoritative empty snapshot when it was the last
// entry. reason is a log label only, never wire data.
func (m *Manager) deregisterClientToolCall(key, requestID, reason string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	removed := false
	if ok && s.pendingClientToolCalls != nil {
		if _, present := s.pendingClientToolCalls[requestID]; present {
			delete(s.pendingClientToolCalls, requestID)
			removed = true
		}
	}
	m.mu.Unlock()
	if !ok || !removed {
		// Session teardown already dropped the map, or a double-deregister
		// raced — either way there is no membership change to announce.
		utils.LogWithFields(utils.LevelDebug, "session.toolgate", "client tool deregister was a no-op", map[string]any{
			"key": key, "gate_request_id": requestID, "reason": reason, "session_found": ok,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tool call deregistered", map[string]any{
		"key": key, "gate_request_id": requestID, "reason": reason,
	})
	m.emitClientToolState(key)
}

// emitClientToolState emits the complete engine_client_tool_state snapshot
// for the session. The slice is always non-nil so the empty state serializes
// as [] — the clear signal consumers replace their local view with.
func (m *Manager) emitClientToolState(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var calls []types.ClientToolCallState
	if ok {
		calls = clientToolCallsSnapshotLocked(s)
	}
	m.mu.RUnlock()
	if !ok {
		return
	}
	utils.LogWithFields(utils.LevelDebug, "session.toolgate", "client tool state snapshot emitted", map[string]any{
		"key": key, "count": len(calls),
	})
	m.emit(key, types.EngineEvent{Type: "engine_client_tool_state", ClientToolCalls: calls})
}

// clientToolCallsSnapshotLocked copies the session's pending client-tool map
// into a non-nil wire slice. Caller holds m.mu (read or write).
func clientToolCallsSnapshotLocked(s *engineSession) []types.ClientToolCallState {
	calls := make([]types.ClientToolCallState, 0, len(s.pendingClientToolCalls))
	for _, call := range s.pendingClientToolCalls {
		calls = append(calls, call)
	}
	return calls
}
