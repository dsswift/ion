package mcp

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
)

// TestTokenFromGrant_CredentialBinding verifies that tokenFromGrant stamps
// the issuer and resource on the resulting OAuthToken.
func TestTokenFromGrant_CredentialBinding(t *testing.T) {
	tok := tokenFromGrant(&auth.TokenResponse{
		AccessToken:  "at-1",
		RefreshToken: "rt-1",
		TokenType:    "Bearer",
		ExpiresAt:    time.Now().Add(time.Hour),
	}, "https://issuer.example.com", "https://api.example.com")

	if tok.Issuer != "https://issuer.example.com" {
		t.Errorf("Issuer = %q, want https://issuer.example.com", tok.Issuer)
	}
	if tok.Resource != "https://api.example.com" {
		t.Errorf("Resource = %q, want https://api.example.com", tok.Resource)
	}
}

// TestTokenFromGrant_EmptyBinding verifies that empty issuer/resource produce
// zero-value strings (backward compatible via omitempty).
func TestTokenFromGrant_EmptyBinding(t *testing.T) {
	tok := tokenFromGrant(&auth.TokenResponse{
		AccessToken: "at-2",
		TokenType:   "Bearer",
		ExpiresAt:   time.Now().Add(time.Hour),
	}, "", "")

	if tok.Issuer != "" {
		t.Errorf("Issuer = %q, want empty", tok.Issuer)
	}
	if tok.Resource != "" {
		t.Errorf("Resource = %q, want empty", tok.Resource)
	}
}

// TestOAuthToken_BackwardCompatMigration verifies that a token persisted
// without the new issuer/resource fields loads cleanly with zero values.
func TestOAuthToken_BackwardCompatMigration(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	ionDir := filepath.Join(tmpDir, ".ion")
	if err := os.MkdirAll(ionDir, 0700); err != nil {
		t.Fatal(err)
	}

	legacy := map[string]*OAuthToken{
		"old-server": {
			AccessToken:  "at-legacy",
			RefreshToken: "rt-legacy",
			TokenType:    "Bearer",
			ExpiresAt:    time.Now().Add(time.Hour),
			Scope:        "read",
		},
	}
	data, _ := json.MarshalIndent(legacy, "", "  ")
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-tokens.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	store := NewOAuthStore()
	tok := store.GetToken("old-server")
	if tok == nil {
		t.Fatal("expected token for old-server")
	}
	if tok.AccessToken != "at-legacy" {
		t.Errorf("AccessToken = %q", tok.AccessToken)
	}
	if tok.Issuer != "" {
		t.Errorf("Issuer = %q, want empty (backward compat)", tok.Issuer)
	}
	if tok.Resource != "" {
		t.Errorf("Resource = %q, want empty (backward compat)", tok.Resource)
	}
}

// TestRefreshToken_CarriesBindingForward verifies that RefreshToken preserves
// issuer and resource from the existing token onto the refreshed one.
func TestRefreshToken_CarriesBindingForward(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	ionDir := filepath.Join(tmpDir, ".ion")
	if err := os.MkdirAll(ionDir, 0700); err != nil {
		t.Fatal(err)
	}

	var gotResource string
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotResource = r.FormValue("resource")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "at-refreshed",
			"refresh_token": "rt-new",
			"token_type":    "Bearer",
			"expires_in":    3600,
		})
	}))
	defer tokenSrv.Close()

	existing := map[string]*OAuthToken{
		"bound-server": {
			AccessToken:  "at-old",
			RefreshToken: "rt-old",
			TokenType:    "Bearer",
			ExpiresAt:    time.Now().Add(-time.Hour),
			Issuer:       "https://issuer.example.com",
			Resource:     "https://api.example.com",
		},
	}
	data, _ := json.MarshalIndent(existing, "", "  ")
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-tokens.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	store := NewOAuthStore()
	config := &OAuthConfig{
		ClientID: "client-1",
		TokenURL: tokenSrv.URL,
		Resource: "https://api.example.com",
	}

	tok, err := store.RefreshToken("bound-server", config)
	if err != nil {
		t.Fatalf("RefreshToken: %v", err)
	}

	if tok.Issuer != "https://issuer.example.com" {
		t.Errorf("Issuer = %q, want https://issuer.example.com (carried from existing)", tok.Issuer)
	}
	if tok.Resource != "https://api.example.com" {
		t.Errorf("Resource = %q, want https://api.example.com (carried from existing)", tok.Resource)
	}
	if gotResource != "https://api.example.com" {
		t.Errorf("resource param in refresh request = %q, want https://api.example.com", gotResource)
	}
	if tok.RefreshToken != "rt-new" {
		t.Errorf("RefreshToken = %q, want rt-new (rotated)", tok.RefreshToken)
	}
}

// TestEffectiveOAuthConfig_IncludesResource verifies that effectiveOAuthConfig
// populates Resource from a stored ClientRegistration.
func TestEffectiveOAuthConfig_IncludesResource(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	ionDir := filepath.Join(tmpDir, ".ion")
	if err := os.MkdirAll(ionDir, 0700); err != nil {
		t.Fatal(err)
	}

	clients := map[string]*ClientRegistration{
		"res-server": {
			ClientID: "client-res",
			AuthURL:  "https://auth.example.com/authorize",
			TokenURL: "https://auth.example.com/token",
			Resource: "https://api.example.com",
		},
	}
	data, _ := json.MarshalIndent(clients, "", "  ")
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-clients.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	resetStoresForTest()

	cfg := effectiveOAuthConfig("res-server", nil)
	if cfg == nil {
		t.Fatal("expected non-nil config from stored registration")
	}
	if cfg.Resource != "https://api.example.com" {
		t.Errorf("Resource = %q, want https://api.example.com", cfg.Resource)
	}
}

// TestClientRegistration_BackwardCompat verifies that a registration persisted
// without the Resource field loads cleanly.
func TestClientRegistration_BackwardCompat(t *testing.T) {
	tmpDir := t.TempDir()
	t.Setenv("HOME", tmpDir)
	ionDir := filepath.Join(tmpDir, ".ion")
	if err := os.MkdirAll(ionDir, 0700); err != nil {
		t.Fatal(err)
	}

	legacy := map[string]*ClientRegistration{
		"legacy-server": {
			ClientID: "client-legacy",
			AuthURL:  "https://auth.example.com/authorize",
			TokenURL: "https://auth.example.com/token",
		},
	}
	data, _ := json.MarshalIndent(legacy, "", "  ")
	if err := os.WriteFile(filepath.Join(ionDir, "mcp-clients.json"), data, 0600); err != nil {
		t.Fatal(err)
	}

	store := NewClientStore()
	reg := store.Get("legacy-server")
	if reg == nil {
		t.Fatal("expected registration for legacy-server")
	}
	if reg.Resource != "" {
		t.Errorf("Resource = %q, want empty (backward compat)", reg.Resource)
	}
}
