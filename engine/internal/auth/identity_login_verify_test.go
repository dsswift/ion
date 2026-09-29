package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// An operator provider configured before issuerUrl was required can still
// open the browser, but every id_token it brings back fails verification and
// the grant is thrown away with nothing reported to the client that asked.
// The sign-in must be refused up front, saying what to configure.
func TestIdentityManager_LoginRefusedWhenResultCannotBeVerified(t *testing.T) {
	cfg := types.OAuthConfig{
		ClientID:               "client-1",
		AuthorizationURL:       "https://login.example.org/tenant/oauth2/v2.0/authorize",
		TokenURL:               "https://login.example.org/tenant/oauth2/v2.0/token",
		DeviceAuthorizationURL: "https://login.example.org/tenant/oauth2/v2.0/devicecode",
		Scopes:                 []string{"openid", "profile", "offline_access"},
	}
	m := NewIdentityManager("entra", cfg, 0)

	login, err := m.BeginLogin()
	if err == nil {
		login.Cancel()
		t.Fatal("BeginLogin started a sign-in that could never be verified")
	}
	if !strings.Contains(err.Error(), "auth.oauth.entra.issuerUrl") {
		t.Errorf("BeginLogin error does not name the missing setting: %v", err)
	}

	if _, err := m.BeginDeviceLogin(); err == nil || !strings.Contains(err.Error(), "issuerUrl") {
		t.Errorf("BeginDeviceLogin error = %v; want a refusal naming issuerUrl", err)
	}
}

// With issuerUrl set, the same configuration starts the browser flow.
func TestIdentityManager_LoginStartsWhenVerifiable(t *testing.T) {
	var issuer *httptest.Server
	issuer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 issuer.URL,
			"authorization_endpoint": issuer.URL + "/authorize",
			"token_endpoint":         issuer.URL + "/token",
		})
	}))
	defer issuer.Close()

	m := NewIdentityManager("entra", types.OAuthConfig{ClientID: "client-1", IssuerURL: issuer.URL, Scopes: []string{"openid"}}, 0)
	login, err := m.BeginLogin()
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	defer login.Cancel()
	if !strings.HasPrefix(login.AuthorizationURL, issuer.URL+"/authorize") {
		t.Errorf("authorization url = %q", login.AuthorizationURL)
	}
}
