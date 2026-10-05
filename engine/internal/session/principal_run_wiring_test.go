package session

import (
	"github.com/dsswift/ion/engine/internal/session/agents"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

func newPrincipalWiringAccessor(principal *types.SessionPrincipal) *sessionAccessor {
	api := backend.NewApiBackend()
	api.SetAuthResolver(auth.NewResolver(&types.AuthConfig{}))
	m := &Manager{backend: api, sessions: map[string]*engineSession{}}
	return &sessionAccessor{m: m, s: &engineSession{agents: agents.NewRegistry(), principal: principal}, key: "tab-1"}
}

// A dispatched child gets the provider credential context and git identity of
// the session it was dispatched from, the same as the session's own runs.
func TestWirePrincipalRunConfig_GivesDispatchedRunTheParentPrincipal(t *testing.T) {
	a := newPrincipalWiringAccessor(&types.SessionPrincipal{Subject: "oidc:alice", DisplayName: "Alice Example", Email: "alice@example.com"})
	cfg := &backend.RunConfig{}
	a.WirePrincipalRunConfig(cfg)

	if cfg.CredentialContext == nil {
		t.Fatal("dispatched run has no credential context; it would send no provider key")
	}
	if got := cfg.CredentialContext.Subject(); got != "oidc:alice" {
		t.Fatalf("credential context subject = %q, want the parent's oidc:alice", got)
	}
	if cfg.ToolEnv["GIT_AUTHOR_NAME"] != "Alice Example" || cfg.ToolEnv["GIT_AUTHOR_EMAIL"] != "alice@example.com" {
		t.Fatalf("dispatched run's git identity = %v, want the parent's", cfg.ToolEnv)
	}
}

// An unattributed parent gives an unattributed child: no principal boundary,
// and a credential context that resolves the process-wide levels (R-10).
func TestWirePrincipalRunConfig_UnattributedParent(t *testing.T) {
	a := newPrincipalWiringAccessor(nil)
	cfg := &backend.RunConfig{}
	a.WirePrincipalRunConfig(cfg)

	if cfg.CredentialContext == nil || cfg.CredentialContext.Subject() != "" {
		t.Fatalf("want an unattributed credential context, got %+v", cfg.CredentialContext)
	}
	if cfg.PrincipalBoundary != nil {
		t.Fatal("an unattributed run must not get a principal boundary")
	}
}

// A dispatched child is bound by the session's permission rules, and can ask
// through the session when a rule says "ask". Without the engine on its
// RunConfig no rule reaches anything the child does.
func TestWirePrincipalRunConfig_GivesDispatchedRunThePermissionRules(t *testing.T) {
	a := newPrincipalWiringAccessor(nil)
	a.m.wireSessionPermissions(a.s, nil)
	if a.s.permEngine == nil {
		t.Fatal("precondition: the session has a permission engine")
	}
	cfg := &backend.RunConfig{}
	a.WirePrincipalRunConfig(cfg)

	if cfg.PermEngine != a.s.permEngine {
		t.Fatal("dispatched run was not given the session's permission engine")
	}
	if cfg.PermissionAsk == nil {
		t.Fatal("dispatched run has no ask bridge")
	}
}
