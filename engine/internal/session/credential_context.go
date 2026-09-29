package session

import (
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// managerAuthResolver returns the auth.Resolver backing this Manager's
// backend, or nil when none is configured (a test harness, or an engine with
// no provider credentials wired at all). *ApiBackend and *HybridBackend both
// carry a resolver; any other RunBackend (ClaudeCodeBackend, a test mock)
// has none, and wireCredentialContext degrades to CredentialContext=nil for
// those sessions -- which is unaffected by this program (delegated-CLI
// backends authenticate through their own subscription/login, never through
// auth.Resolver).
func (m *Manager) managerAuthResolver() *auth.Resolver {
	switch b := m.backend.(type) {
	case *backend.ApiBackend:
		return b.AuthResolver()
	case *backend.HybridBackend:
		if api := b.InnerApi(); api != nil {
			return api.AuthResolver()
		}
	}
	return nil
}

// wireCredentialContext builds this run's per-principal credential
// resolution (SC-2) and stamps it onto runCfg, mirroring wireGitIdentity's
// per-run wiring pattern exactly. Nil CredentialContext (no resolver
// available) means the run falls through to whatever the provider's own
// unattributed path already does -- R-10 is preserved because
// resolveProviderAndAttachAuth (backend package) builds its own ephemeral
// CredentialContext from the backend's resolver when the RunConfig's is nil.
func (m *Manager) wireCredentialContext(key string, principal *types.SessionPrincipal, runCfg *backend.RunConfig) {
	resolver := m.managerAuthResolver()
	if resolver == nil {
		utils.LogWithFields(utils.LevelDebug, "session", "credential context: no auth resolver on this backend", map[string]any{"key": key})
		return
	}
	// child 04's tenancy-derived fall-through policy: refuses an attributed
	// principal with no resolvable credential on a partitioned instance,
	// unless the operator opted into fall-through. Derived from m.config,
	// which already carries the enterprise seal folded in.
	policy := auth.NewTenancyFallThroughPolicy(m.config)
	cc := auth.NewCredentialContext(principal, resolver, policy)

	// Entitlement (child 05, R-12): the principal's discovered model-id set
	// per provider, shared with the list_models per-command path
	// (dispatch_data.go) via providers.WireEntitlement so both callers get
	// identical behavior from one implementation.
	var providerConfigs map[string]types.ProviderConfig
	if m.config != nil {
		providerConfigs = m.config.Providers
	}
	providers.WireEntitlement(cc, providerConfigs)

	runCfg.CredentialContext = cc
	utils.LogWithFields(utils.LevelInfo, "session", "credential context wired", map[string]any{
		"key": key, "subject": cc.Subject(), "attributed": principal != nil,
	})
}
