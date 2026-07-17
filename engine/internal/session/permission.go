package session

import (

	"github.com/dsswift/ion/engine/internal/utils"
)

// SendPermissionResponse resolves a pending permission request from the hook server.
func (m *Manager) SendPermissionResponse(key, questionID, optionID string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session", "permission response for unknown session", map[string]any{"key": key})
		return
	}
	s.pending.ResolvePermission(questionID, optionID)
}

// RegisterPendingPermission creates a channel for an in-flight permission request.
// Returns the channel the hook server should block on.
func (m *Manager) RegisterPendingPermission(key, questionID string) chan string {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return s.pending.RegisterPermission(questionID)
}

// UnregisterPendingPermission removes a pending permission entry.
func (m *Manager) UnregisterPendingPermission(key, questionID string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}
	s.pending.UnregisterPermission(questionID)
}
