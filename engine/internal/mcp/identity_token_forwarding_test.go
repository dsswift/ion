package mcp

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// recordingTokenProvider mints "tok|<scope>|<audience>" so a test can read
// which scope and audience the transport requested from the wire header.
type recordingTokenProvider struct{}

func (recordingTokenProvider) GetToken(ctx context.Context, scope string) (string, error) {
	return recordingTokenProvider{}.GetTokenWithAudience(ctx, scope, "")
}

func (recordingTokenProvider) GetTokenWithAudience(_ context.Context, scope, audience string) (string, error) {
	return fmt.Sprintf("tok|%s|%s", scope, audience), nil
}

// forwardedAuthorization sends one request through the MCP HTTP client built
// for config and returns the Authorization header the server received.
func forwardedAuthorization(t *testing.T, config types.McpServerConfig) string {
	t.Helper()
	auth.SetTokenProvider(recordingTokenProvider{})
	t.Cleanup(func() { auth.SetTokenProvider(nil) })

	var got string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	config.Type = "http"
	config.URL = server.URL
	resp, err := ionMCPHTTPClient("forwarding-test", config).Get(server.URL)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if err := resp.Body.Close(); err != nil {
		t.Fatalf("close body: %v", err)
	}
	return got
}

func TestIdentityTokenForwarding(t *testing.T) {
	cases := []struct {
		name   string
		config types.McpServerConfig
		want   string
	}{
		{
			name:   "generic field alone forwards with generic scope and audience",
			config: types.McpServerConfig{ForwardIdentityToken: true, IdentityTokenScope: "id-scope", IdentityTokenAudience: "id-aud"},
			want:   "Bearer tok|id-scope|id-aud",
		},
		{
			name:   "legacy field alone forwards with legacy scope and audience",
			config: types.McpServerConfig{ForwardUserToken: true, UserTokenScope: "user-scope", UserTokenAudience: "user-aud"},
			want:   "Bearer tok|user-scope|user-aud",
		},
		{
			name: "generic field wins over legacy values when both are set",
			config: types.McpServerConfig{
				ForwardIdentityToken: true, IdentityTokenScope: "id-scope", IdentityTokenAudience: "id-aud",
				ForwardUserToken: true, UserTokenScope: "user-scope", UserTokenAudience: "user-aud",
			},
			want: "Bearer tok|id-scope|id-aud",
		},
		{
			name:   "generic field with empty values selects provider defaults over legacy values",
			config: types.McpServerConfig{ForwardIdentityToken: true, UserTokenScope: "user-scope", UserTokenAudience: "user-aud"},
			want:   "Bearer tok||",
		},
		{
			name:   "neither field forwards nothing",
			config: types.McpServerConfig{IdentityTokenScope: "id-scope", UserTokenScope: "user-scope"},
			want:   "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := forwardedAuthorization(t, tc.config); got != tc.want {
				t.Errorf("Authorization = %q, want %q", got, tc.want)
			}
		})
	}
}
