package providers

import (
	"net/http"
	"strings"
	"testing"
)

// TestPrincipalCredentialRefusal pins SC-4: the refusal applyRequestAuth
// raises for a context carrying a credential-refusal marker is typed
// ErrAuth, non-retryable (so child 07's 401 self-heal never treats this as
// transient), carries ReasonPrincipalCredentialUnresolved, and is raised
// BEFORE any request-shaped work happens -- applyRequestAuth checks the
// refusal marker as its very first branch.
func TestPrincipalCredentialRefusal(t *testing.T) {
	ctx := WithCredentialRefusal(t.Context(), "alice")
	req, _ := http.NewRequest(http.MethodGet, "https://api.anthropic.com/v1/messages", nil) //nolint:errcheck // test fixture

	pe := applyRequestAuth(ctx, req, nil, "anthropic")
	if pe == nil {
		t.Fatal("expected a refusal error, got nil")
	}
	if pe.Code != ErrAuth {
		t.Errorf("code = %q, want %q", pe.Code, ErrAuth)
	}
	if pe.Retryable {
		t.Error("expected the refusal to be non-retryable")
	}
	if pe.Reason != ReasonPrincipalCredentialUnresolved {
		t.Errorf("reason = %q, want %q", pe.Reason, ReasonPrincipalCredentialUnresolved)
	}
	if pe.HTTPStatus != 401 {
		t.Errorf("status = %d, want 401", pe.HTTPStatus)
	}
}

// TestRefusalMessageCarriesNoSecret pins the secrets gate: the refusal
// message names no credential value and no source value -- only the
// provider id and the generic reason.
func TestRefusalMessageCarriesNoSecret(t *testing.T) {
	pe := NewPrincipalCredentialError("anthropic", "alice")
	lower := strings.ToLower(pe.Message)
	for _, forbidden := range []string{"sk-", "bearer ", "x-api-key", "secret", "token:"} {
		if strings.Contains(lower, forbidden) {
			t.Errorf("refusal message contains a credential-shaped substring %q: %q", forbidden, pe.Message)
		}
	}
	// The message may legitimately name the provider id (it is not a
	// secret), but it must never name the subject either -- the ledger of
	// WHO was refused belongs in logs (structured fields), not in an error
	// string a client might display or a bug report might paste verbatim.
	if strings.Contains(pe.Message, "alice") {
		t.Errorf("refusal message names the subject, which should stay out of the client-facing message: %q", pe.Message)
	}
}

// TestApplyRequestAuth_RefusalOutranksNoCredential proves the refusal check
// runs before the "no credential attached" fallback -- a refused principal on
// a custom base URL (never key-required) must still refuse, not silently
// proceed keyless.
func TestApplyRequestAuth_RefusalOutranksNoCredential(t *testing.T) {
	ctx := WithCredentialRefusal(t.Context(), "alice")
	req, _ := http.NewRequest(http.MethodGet, "https://gateway.corp.example/v1/messages", nil) //nolint:errcheck // test fixture

	pe := applyRequestAuth(ctx, req, nil, "custom-gateway")
	if pe == nil {
		t.Fatal("expected the refusal to fire even against a custom (never key-required) host")
	}
	if pe.Reason != ReasonPrincipalCredentialUnresolved {
		t.Errorf("reason = %q, want %q", pe.Reason, ReasonPrincipalCredentialUnresolved)
	}
}
