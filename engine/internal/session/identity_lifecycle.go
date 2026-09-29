package session

import (
	"reflect"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// fireInitialIdentityChanged runs after host callbacks and group wiring, before
// session_start. Hosts without the hook are a no-op through the normal SDK path.
func (m *Manager) fireInitialIdentityChanged(s *engineSession, key string) {
	identity := currentSessionIdentity()
	m.fireIdentityChanged(s, key, auth.ContextIdentityChange{Identity: identity, Reason: "initial"})
}

func (m *Manager) handleIdentityChange(change auth.ContextIdentityChange) {
	m.mu.RLock()
	sessions := make([]struct {
		session *engineSession
		key     string
	}, 0, len(m.sessions))
	for key, session := range m.sessions {
		sessions = append(sessions, struct {
			session *engineSession
			key     string
		}{session, key})
	}
	m.mu.RUnlock()
	for _, entry := range sessions {
		m.fireIdentityChanged(entry.session, entry.key, change)
	}
}

func (m *Manager) fireIdentityChanged(s *engineSession, key string, change auth.ContextIdentityChange) {
	m.mu.Lock()
	group := s.extGroup
	if change.Reason != "initial" && s.identityInitialized && identityChangeEqual(s.identitySnapshot, change.Identity) {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()
	if group == nil || group.IsEmpty() {
		return
	}
	for _, host := range group.Hosts() {
		if !host.DeclaresHook(extension.HookIdentityChanged) {
			continue
		}
		ctx := m.newExtContext(s, key)
		// Process-level identity firing (this path) always carries an empty
		// SessionKey, distinguishing it from fireIdentityChangedForSession's
		// per-session firing below (manifest C2).
		info := extension.IdentityChangedInfo{Identity: change.Identity, Reason: change.Reason}
		if err := host.FireIdentityChanged(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.identity", "identity hook failed", map[string]any{"session_id": key, "extension": host.Name(), "reason": change.Reason, "error": err.Error()})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "session.identity", "identity hook applied", map[string]any{"session_id": key, "extension": host.Name(), "reason": change.Reason})
	}
	m.mu.Lock()
	s.identitySnapshot = change.Identity
	s.identityInitialized = true
	m.mu.Unlock()
}

// fireIdentityChangedForSession fires identity_changed with SessionKey set
// (manifest C2) when a session's own stamped principal is set or replaced by
// a later start_session. Unlike fireIdentityChanged above (the process-level
// operator-identity path, always SessionKey == ""), this always carries the
// session's key, because it exists specifically to tell an extension WHICH
// session's principal changed. Identity carries the new principal projected
// to auth.ContextIdentity so handlers see the same shape as any other
// identity_changed firing.
func (m *Manager) fireIdentityChangedForSession(key string, principal *types.SessionPrincipal) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	var group *extension.ExtensionGroup
	if ok {
		group = s.extGroup
	}
	m.mu.RUnlock()
	if !ok || group == nil || group.IsEmpty() {
		return
	}
	identity := auth.FromSessionPrincipal(principal)
	for _, host := range group.Hosts() {
		if !host.DeclaresHook(extension.HookIdentityChanged) {
			continue
		}
		ctx := m.newExtContext(s, key)
		info := extension.IdentityChangedInfo{Identity: identity, Reason: "session_principal", SessionKey: key}
		if err := host.FireIdentityChanged(ctx, info); err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.identity", "session identity hook failed", map[string]any{"session_id": key, "extension": host.Name(), "error": err.Error()})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "session.identity", "session identity hook applied", map[string]any{"session_id": key, "extension": host.Name()})
	}
}

func identityChangeEqual(left, right *auth.ContextIdentity) bool {
	return reflect.DeepEqual(left, right)
}
