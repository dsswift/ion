package session

import "github.com/dsswift/ion/engine/internal/types"

// StartSession creates a new session with the given config.
func (m *Manager) StartSession(key string, config types.EngineConfig) (*StartSessionResult, error) {
	return m.startSession(key, config, nil, nil)
}
