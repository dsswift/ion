package session

// policy_config.go — the engine config as one account sees it.
//
// m.config carries the enterprise policy resolved for the engine process. A
// machine policy may also scope policy to principals. Those entries are
// resolved here, for the principal a session or turn acts as, and enforced
// over m.config. Each principal's result is held under that principal's own
// key and is never read for another.

import (
	"encoding/json"
	"sync"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// policyView is the config and the compiled command patterns that apply to
// one principal.
type policyView struct {
	cfg      *types.EngineRuntimeConfig
	patterns []sandbox.CompiledPattern
}

// policyCacheMax bounds the resolved views kept in memory.
const policyCacheMax = 1024

// policyCache holds resolved views by principal, for one base config.
type policyCache struct {
	mu    sync.Mutex
	base  *types.EngineRuntimeConfig
	views map[string]policyView
}

// policyView returns the view for principal. With no principal-scoped
// account policy configured it is m.config itself, for every principal.
func (m *Manager) policyView(principal *types.SessionPrincipal) policyView {
	base, patterns := m.config, m.commandPatterns
	if base == nil || !ionconfig.HasSessionScopedPolicies(base.Enterprise) {
		return policyView{cfg: base, patterns: patterns}
	}

	key := principalPolicyKey(principal)
	m.policies.mu.Lock()
	defer m.policies.mu.Unlock()
	if m.policies.base != base || len(m.policies.views) >= policyCacheMax {
		m.policies.base = base
		m.policies.views = map[string]policyView{}
	}
	if view, ok := m.policies.views[key]; ok {
		return view
	}
	cfg := ionconfig.EnforceEnterprise(base, ionconfig.ResolveEnterpriseForPrincipal(base.Enterprise, principal))
	view := policyView{cfg: cfg, patterns: compileCommandPatterns(cfg)}
	m.policies.views[key] = view
	subject := ""
	if principal != nil {
		subject = principal.Subject
	}
	utils.LogWithFields(utils.LevelInfo, "session", "account policy resolved for principal", map[string]any{
		"principal_subject": subject, "attributed": principal != nil, "asset_scopes": cfg.Enterprise.AssetScopes,
	})
	return view
}

// policyConfig is policyView's config alone.
func (m *Manager) policyConfig(principal *types.SessionPrincipal) *types.EngineRuntimeConfig {
	return m.policyView(principal).cfg
}

// principalPolicyKey identifies a principal by everything an account policy
// can match on, so two principals that differ in any matched dimension never
// share a view.
func principalPolicyKey(principal *types.SessionPrincipal) string {
	if principal == nil {
		return ""
	}
	encoded, err := json.Marshal(struct {
		Subject  string         `json:"s"`
		Provider string         `json:"p"`
		Claims   map[string]any `json:"c"`
	}{principal.Subject, principal.Provider, principal.Claims})
	if err != nil {
		// Unencodable claims: fall back to a key no other principal can
		// produce, so the view is resolved fresh rather than shared.
		return "!" + principal.Subject + "\x00" + principal.Provider + "\x00" + err.Error()
	}
	return string(encoded)
}

// wireSessionPermissions builds the session's permission engine from the
// policy that applies to principal. The caller holds m.mu.
func (m *Manager) wireSessionPermissions(s *engineSession, principal *types.SessionPrincipal) {
	cfg := m.policyConfig(principal)
	if cfg != nil && cfg.Permissions != nil {
		s.permEngine = permissions.NewEngine(cfg.Permissions)
		// G01: the LLM classifier settles ambiguous commands in "ask" mode.
		if cfg.Permissions.Mode == "ask" {
			s.permEngine.SetClassifier(permissions.NewLlmClassifier(""))
		}
		return
	}
	// Default allow-all when no policy is configured.
	s.permEngine = permissions.NewEngine(&permissions.DefaultPolicy)
}
