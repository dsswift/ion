package session

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/principalboundary"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePrincipalRun stamps everything on runCfg that depends on WHO the run
// acts as: the OS sandbox (FR-03), the in-process principal execution
// boundary, the git identity and caller ToolEnv (FR-04), and the provider
// credential context (SC-2). A session's own runs and every run dispatched
// from it act as the same principal, so both build this wiring here rather
// than one of them building it and the other running as nobody.
func (m *Manager) wirePrincipalRun(s *engineSession, key string, principal *types.SessionPrincipal, runCfg *backend.RunConfig) {
	// The sandbox is nil when neither the user layer nor a sealed enterprise
	// requirement enables it (buildSandboxConfig). The boundary is nil when
	// partitioning is off or the session is unattributed (principalboundary.New).
	runCfg.SandboxCfg = buildSandboxConfig(m, principal)
	if principal != nil {
		runCfg.PrincipalBoundary = principalboundary.New(principal.Subject, conversation.PartitioningEnforcement())
	}
	m.wireGitIdentity(s, key, principal, runCfg)
	m.wireCredentialContext(key, principal, runCfg)
}

// WirePrincipalRunConfig gives a dispatched child run its parent session's
// principal wiring (wirePrincipalRun). Without it the child acts as nobody:
// on a partitioned instance every provider credential is refused for it, and
// its tools run outside the principal's boundary and git identity.
func (a *sessionAccessor) WirePrincipalRunConfig(cfg *backend.RunConfig) {
	principal := a.s.principal
	a.m.wirePrincipalRun(a.s, a.key, principal, cfg)
	subject := ""
	if principal != nil {
		subject = principal.Subject
	}
	utils.LogWithFields(utils.LevelInfo, "session", "dispatched run wired to parent principal", map[string]any{
		"key": a.key, "subject": subject, "attributed": principal != nil,
	})
}
