package session

// AbortAgent retains the published name-addressed process-control API. New
// clients should use AbortDispatch for engine-native dispatches because a name
// can identify more than one concurrent dispatch. This method remains for
// existing wire and Go-SDK consumers that registered OS-process handles.
func (m *Manager) AbortAgent(key, agentName string, subtree bool) {
	if agentName == "" && subtree {
		m.abortAllDescendants(key, "user abort (all)")
		return
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}

	for name, handle := range s.agents.AllHandles() {
		if name == agentName || (subtree && s.agents.IsDescendant(name, agentName)) {
			killProcess(handle.PID)
		}
	}
}
