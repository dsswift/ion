package auth

import "sync"

// Package-level operator identity registry.
//
// The IdentityManager is constructed once at serve startup (from
// auth.identityProvider in engine.json) and consumed across subsystems that
// cannot all be reached by constructor injection without threading the
// manager through every layer: the extension SDK's pre-authenticated HTTP
// surface, per-server MCP token forwarding, and authenticated log egress.
// This mirrors the established package-level injection pattern used for
// cross-cutting engine singletons (providers.SetProviderKey,
// titling.SetAuthResolver).

var (
	operatorMu sync.RWMutex
	operator   *IdentityManager
)

// SetOperator installs the process-wide operator identity manager. Call
// once at serve startup; nil clears it (used by tests).
func SetOperator(m *IdentityManager) {
	operatorMu.Lock()
	operator = m
	operatorMu.Unlock()
}

// Operator returns the process-wide operator identity manager, or nil when
// no identity provider is configured. Callers must nil-check and surface a
// clear "no operator identity configured" error to their consumer.
func Operator() *IdentityManager {
	operatorMu.RLock()
	defer operatorMu.RUnlock()
	return operator
}
