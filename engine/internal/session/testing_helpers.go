package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestNewExtContext builds a fully-populated extension Context for the given
// session key. Exported for integration tests only.
func (m *Manager) TestNewExtContext(key string) *extension.Context {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return m.newExtContext(s, key)
}

// TestNewExtContextWithOpts builds a depth-aware extension Context for the
// given session key. The caller controls the dispatch depth, dispatch ID, and
// registry via ExtContextOpts. This is the integration-test entry point for
// simulating a dispatched agent's own context (depth > 0) so the agent can
// dispatch children at depth+1. Exported for integration tests only.
func (m *Manager) TestNewExtContextWithOpts(key string, opts extcontext.ExtContextOpts) *extension.Context {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	if opts.Registry == nil {
		opts.Registry = s.dispatchRegistry
	}
	return extcontext.NewExtContext(&sessionAccessor{m: m, s: s, key: key}, opts)
}

// TestSetExtGroup wires an ExtensionGroup onto an existing session.
// Exported for integration tests only.
func (m *Manager) TestSetExtGroup(key string, group *extension.ExtensionGroup) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if s, ok := m.sessions[key]; ok {
		s.extGroup = group
	}
}

// TestRegisterAgentSpec registers an agent spec on the session.
// Exported for integration tests only.
func (m *Manager) TestRegisterAgentSpec(key string, spec types.AgentSpec) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}
	s.agents.RegisterSpec(spec)
}

// TestWireAgentToolServer calls wireAgentToolServer for the given session.
// Exported for integration tests only.
func (m *Manager) TestWireAgentToolServer(key string, opts *types.RunOptions) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}
	m.wireAgentToolServer(s, key, opts)
}

// TestGetToolServerSocketPath returns the ToolServer's socket path for the session.
// Exported for integration tests only.
func (m *Manager) TestGetToolServerSocketPath(key string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	if !ok || s.toolServer == nil {
		return ""
	}
	return s.toolServer.SocketPath()
}

// TestNewChildBackend exposes newChildBackend for integration tests.
func (m *Manager) TestNewChildBackend() backend.RunBackend {
	return m.newChildBackend()
}

// TestBuildAgentToolHandler exposes buildAgentToolHandler for e2e tests.
// Returns the handler closure, or nil if the session does not exist.
func (m *Manager) TestBuildAgentToolHandler(key string) backend.ToolHandler {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return nil
	}
	return m.buildAgentToolHandler(s, key)
}

// TestGetPlanModeBashAllowlist returns the session's bash allowlist
// (the engine-side state set by SetPlanModeBashAllowlist). Returns
// (nil, false) when the session does not exist. The first return value
// follows the same nil-vs-empty distinction the wire field uses: nil
// means "never set", empty slice means "explicitly cleared". Exported
// for the tri-valued dispatch tests in `server/server_set_plan_mode_test.go`.
func (m *Manager) TestGetPlanModeBashAllowlist(key string) (cmds []string, ok bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, exists := m.sessions[key]
	if !exists {
		return nil, false
	}
	return s.planModeAllowedBashCommands, true
}
