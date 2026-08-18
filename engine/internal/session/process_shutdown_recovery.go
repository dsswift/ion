package session

// PrepareForProcessShutdown marks subsequent StopSession calls as daemon
// teardown. The server invokes it before StopAll so active-run journals survive
// process replacement, while explicit stop_session continues to disarm them.
func (m *Manager) PrepareForProcessShutdown() {
	m.mu.Lock()
	m.shuttingDown = true
	m.mu.Unlock()
}

// IsProcessShutdownPrepared reports whether session stop calls preserve active
// journals because the whole engine process is terminating.
func (m *Manager) IsProcessShutdownPrepared() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.shuttingDown
}
