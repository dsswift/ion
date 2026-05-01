package session

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// SendPermissionResponse resolves a pending permission request from the hook server.
func (m *Manager) SendPermissionResponse(key, questionID, optionID string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("permission response for unknown session %s", key))
		return
	}

	ch, exists := s.pendingPermissions[questionID]
	m.mu.RUnlock()

	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending permission %s for session %s", questionID, key))
		return
	}
	// Non-blocking send -- if nobody is waiting, drop silently.
	select {
	case ch <- optionID:
	default:
	}
}

// RegisterPendingPermission creates a channel for an in-flight permission request.
// Returns the channel the hook server should block on.
func (m *Manager) RegisterPendingPermission(key, questionID string) chan string {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return nil
	}
	ch := make(chan string, 1)
	s.pendingPermissions[questionID] = ch
	return ch
}

// UnregisterPendingPermission removes a pending permission entry.
func (m *Manager) UnregisterPendingPermission(key, questionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return
	}
	delete(s.pendingPermissions, questionID)
}
