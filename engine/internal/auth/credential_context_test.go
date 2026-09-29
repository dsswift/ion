package auth

import (
	"context"
	"net/http"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestNewCredentialContext_UnattributedFallsThrough(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "sk-unattributed")

	r := NewResolver(nil)
	cc := NewCredentialContext(nil, r, allowAllFallThrough{})
	if cc.Subject() != "" {
		t.Fatalf("expected unattributed subject, got %q", cc.Subject())
	}
	a, err := cc.Authenticator(context.Background(), "anthropic")
	if err != nil || a == nil {
		t.Fatalf("expected the resolver fallback to authenticate, err=%v a=%v", err, a)
	}
}

func TestNewCredentialContext_PrincipalSourceOutranksResolver(t *testing.T) {
	UnregisterAllPrincipalSourcesForTest()
	defer UnregisterAllPrincipalSourcesForTest()

	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "sk-resolver-level")

	RegisterPrincipalSource(stubSource{name: "test", resolve: func(_ context.Context, scope CredentialScope) (RequestAuthenticator, error) {
		if scope.Subject == "alice" {
			return recordingAuthenticator{label: "alice-source"}, nil
		}
		return nil, nil
	}})

	r := NewResolver(nil)
	principal := &types.SessionPrincipal{Subject: "alice"}
	cc := NewCredentialContext(principal, r, allowAllFallThrough{})
	a, err := cc.Authenticator(context.Background(), "anthropic")
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://example.com", nil)
	if err := a.Authenticate(context.Background(), req, nil); err != nil {
		t.Fatal(err)
	}
	if req.Header.Get("X-Test-Source") != "alice-source" {
		t.Fatalf("expected the registered principal source to outrank the resolver, got %q", req.Header.Get("X-Test-Source"))
	}
}

func TestAuthHeaderFor(t *testing.T) {
	cases := map[string]string{
		"anthropic": "x-api-key",
		"Anthropic": "x-api-key",
		"openai":    "bearer",
		"foundry":   "x-api-key",
		"vertex":    "bearer",
		"unknown":   "bearer",
	}
	for provider, want := range cases {
		if got := authHeaderFor(provider); got != want {
			t.Errorf("authHeaderFor(%q) = %q, want %q", provider, got, want)
		}
	}
}
