package session

import "github.com/dsswift/ion/engine/internal/types"

// StartSession creates a new session with the given config and, optionally,
// the principal (manifest C1/C2) this session is attributed to. principal is
// variadic so every one of the engine's existing call sites (production and
// the several hundred across the test suite) compiles unchanged; only the
// first supplied value is used, and no value at all preserves pre-existing
// behavior exactly -- no attribution is stored or stamped.
func (m *Manager) StartSession(key string, config types.EngineConfig, principal ...*types.SessionPrincipal) (*StartSessionResult, error) {
	var p *types.SessionPrincipal
	if len(principal) > 0 {
		p = principal[0]
	}
	return m.startSession(key, config, p, nil, nil)
}
