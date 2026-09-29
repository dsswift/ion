package mcp

// oauth_explicit_client_test.go — an engine.json `oauth` block that names only a
// client_id. Login discovers the endpoints; the refresh path must find them
// again from the registration login stored, or the server loses its
// authorization the first time the access token expires.

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestClientIDOnlyConfig_RefreshUsesEndpointsFromLogin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	fix := newRefreshFixture(t, "original")
	// Expired token plus the registration login stored for client c1.
	fix.seedStores("original", time.Now().Add(-1*time.Minute))

	cfg := fix.config()
	cfg.OAuth = &types.McpOAuthConfig{ClientID: "c1"}

	conn, err := Connect("srv", cfg)
	if err != nil {
		t.Fatalf("Connect with a client_id-only oauth block and an expired token: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()
	if fix.refreshCalls.Load() == 0 {
		t.Error("expected the expired token to be refreshed against the stored token endpoint")
	}
}

func TestClientIDOnlyConfig_IgnoresRegistrationForAnotherClient(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "dcr-client",
		AuthURL:  "https://auth.example.test/authorize",
		TokenURL: "https://auth.example.test/token",
	})

	got := effectiveOAuthConfig("srv", &OAuthConfig{ClientID: "operator-client"})
	if got.TokenURL != "" || got.AuthURL != "" {
		t.Errorf("endpoints from another client's registration were mixed in: auth=%q token=%q", got.AuthURL, got.TokenURL)
	}
}

func TestExplicitEndpointsWinOverStoredRegistration(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	getClientStore().Set("srv", &ClientRegistration{
		ClientID: "c1",
		AuthURL:  "https://stored.example.test/authorize",
		TokenURL: "https://stored.example.test/token",
		Scope:    "stored-scope",
	})

	got := effectiveOAuthConfig("srv", &OAuthConfig{ClientID: "c1", TokenURL: "https://operator.example.test/token", Scope: "operator-scope"})
	if got.TokenURL != "https://operator.example.test/token" {
		t.Errorf("TokenURL = %q, want the operator's value", got.TokenURL)
	}
	if got.Scope != "operator-scope" {
		t.Errorf("Scope = %q, want the operator's value", got.Scope)
	}
	if got.AuthURL != "https://stored.example.test/authorize" {
		t.Errorf("AuthURL = %q, want the stored value filling the gap", got.AuthURL)
	}
}
