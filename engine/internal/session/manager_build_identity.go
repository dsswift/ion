package session

// SetEngineBuildIdentity stores the engine binary's build identity so every
// extension host can validate that its SDK subprocess came from the same build.
func (m *Manager) SetEngineBuildIdentity(id string) {
	m.mu.Lock()
	m.engineBuildIdentity = id
	m.mu.Unlock()
}

// engineBuildIdentitySnapshot returns the current engine build identity under
// the manager lock. Host construction must use one snapshot for both the host
// handshake and extension configuration.
func (m *Manager) engineBuildIdentitySnapshot() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.engineBuildIdentity
}
