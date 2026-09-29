package extension

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
)

// stubPrincipalTokenProvider is a minimal auth.PrincipalTokenProvider for
// this test: GetToken (the unattributed path) always returns "process-token";
// GetTokenForSubject returns a token that names the subject, so a test can
// tell which path answered.
type stubPrincipalTokenProvider struct{}

func (stubPrincipalTokenProvider) GetToken(_ context.Context, _ string) (string, error) {
	return "process-token", nil
}
func (stubPrincipalTokenProvider) GetTokenWithAudience(_ context.Context, _, _ string) (string, error) {
	return "process-token", nil
}
func (stubPrincipalTokenProvider) GetTokenForSubject(_ context.Context, subject, _, _ string) (string, error) {
	return "token-for-" + subject, nil
}

// TestExtensionRequestUsesPrincipalProvider pins R-43: an extension HTTP
// request made with a Subject on ctx (auth.WithSubject) authenticates as
// THAT principal -- via auth.TokenProviderForSubject's subjectBoundProvider
// -- not the process-wide CurrentTokenProvider() alone.
func TestExtensionRequestUsesPrincipalProvider(t *testing.T) {
	auth.SetTokenProvider(stubPrincipalTokenProvider{})
	t.Cleanup(func() { auth.SetTokenProvider(nil) })

	var downstreamAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	ctx := auth.WithSubject(context.Background(), "alice")
	_, err := DoOperatorHTTPRequest(ctx, OperatorHTTPRequestParams{
		URL: target.URL, AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("authenticated request: %v", err)
	}
	if downstreamAuth != "Bearer token-for-alice" {
		t.Fatalf("downstream Authorization = %q, want the principal-scoped token", downstreamAuth)
	}
}

// TestExtensionRequestUnattributedUnchanged pins B-24: a request with no
// Subject on ctx (the pre-existing shape, e.g. a schedule/webhook-triggered
// extension) authenticates through CurrentTokenProvider() unchanged.
func TestExtensionRequestUnattributedUnchanged(t *testing.T) {
	auth.SetTokenProvider(stubPrincipalTokenProvider{})
	t.Cleanup(func() { auth.SetTokenProvider(nil) })

	var downstreamAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: target.URL, AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("authenticated request: %v", err)
	}
	if downstreamAuth != "Bearer process-token" {
		t.Fatalf("downstream Authorization = %q, want the unattributed process-wide token", downstreamAuth)
	}
}
