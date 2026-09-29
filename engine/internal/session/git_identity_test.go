package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveGitIdentity_PrincipalDisplayNameAndEmail(t *testing.T) {
	principal := &types.SessionPrincipal{Subject: "oidc:alice", DisplayName: "Alice Example", Email: "alice@example.com"}
	author, ok := resolveGitIdentity(nil, principal)
	if !ok {
		t.Fatal("expected the principal's display name + email to resolve")
	}
	if author.Name != "Alice Example" || author.Email != "alice@example.com" {
		t.Errorf("author = %+v, want Alice Example / alice@example.com", author)
	}
}

func TestResolveGitIdentity_FallsBackToUsernameWhenNoDisplayName(t *testing.T) {
	principal := &types.SessionPrincipal{Subject: "oidc:alice", Username: "alice", Email: "alice@example.com"}
	author, ok := resolveGitIdentity(nil, principal)
	if !ok || author.Name != "alice" {
		t.Errorf("expected username fallback, got %+v ok=%v", author, ok)
	}
}

func TestResolveGitIdentity_PrincipalMissingEmailFallsBackToMachine(t *testing.T) {
	principal := &types.SessionPrincipal{Subject: "oidc:alice", DisplayName: "Alice Example"}
	cfg := &types.GitConfig{Identity: types.GitIdentityConfig{
		Machine: &types.GitAuthor{Name: "CI Bot", Email: "ci@example.com"},
	}}
	author, ok := resolveGitIdentity(cfg, principal)
	if !ok || author.Name != "CI Bot" || author.Email != "ci@example.com" {
		t.Errorf("expected machine fallback when principal has no email, got %+v ok=%v", author, ok)
	}
}

func TestResolveGitIdentity_FromPrincipalDisabledUsesMachineDirectly(t *testing.T) {
	disabled := false
	principal := &types.SessionPrincipal{Subject: "oidc:alice", DisplayName: "Alice Example", Email: "alice@example.com"}
	cfg := &types.GitConfig{Identity: types.GitIdentityConfig{
		FromPrincipal: &disabled,
		Machine:       &types.GitAuthor{Name: "CI Bot", Email: "ci@example.com"},
	}}
	author, ok := resolveGitIdentity(cfg, principal)
	if !ok || author.Name != "CI Bot" {
		t.Errorf("expected machine identity when FromPrincipal is disabled, got %+v ok=%v", author, ok)
	}
}

func TestResolveGitIdentity_NeitherSourceResolves(t *testing.T) {
	author, ok := resolveGitIdentity(nil, nil)
	if ok || author != nil {
		t.Errorf("expected unresolved with no principal and no config, got %+v ok=%v", author, ok)
	}
}

func TestResolveGitIdentity_MachineMissingEmailDoesNotCount(t *testing.T) {
	cfg := &types.GitConfig{Identity: types.GitIdentityConfig{
		Machine: &types.GitAuthor{Name: "CI Bot"},
	}}
	author, ok := resolveGitIdentity(cfg, nil)
	if ok || author != nil {
		t.Errorf("a machine identity missing an email must not resolve, got %+v ok=%v", author, ok)
	}
}

func TestGitIdentityEnv_NilAuthorReturnsNil(t *testing.T) {
	if env := gitIdentityEnv(nil); env != nil {
		t.Errorf("expected nil env for a nil author, got %v", env)
	}
}

func TestGitIdentityEnv_BuildsAllFourVariables(t *testing.T) {
	env := gitIdentityEnv(&types.GitAuthor{Name: "Alice Example", Email: "alice@example.com"})
	want := map[string]string{
		"GIT_AUTHOR_NAME":     "Alice Example",
		"GIT_AUTHOR_EMAIL":    "alice@example.com",
		"GIT_COMMITTER_NAME":  "Alice Example",
		"GIT_COMMITTER_EMAIL": "alice@example.com",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("env[%q] = %q, want %q", k, env[k], v)
		}
	}
}
