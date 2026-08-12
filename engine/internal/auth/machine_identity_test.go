package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestNewMachineIdentityManager_ClientSecretEnv_ScrubsEnv(t *testing.T) {
	const envVar = "ION_TEST_SECRET_SCRUB"
	t.Setenv(envVar, "my-secret-value")

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if got := r.FormValue("client_secret"); got != "my-secret-value" {
			t.Errorf("client_secret = %q, want my-secret-value", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"tok","expires_in":3600}`)) //nolint:errcheck
	}))
	defer ts.Close()

	cfg := types.OAuthConfig{
		ClientID: "test-client",
		TokenURL: ts.URL,
		Scopes:   []string{"api"},
		MachineIdentity: &types.MachineIdentityConfig{
			Source:          "client_secret",
			ClientSecretEnv: envVar,
		},
	}
	m, err := NewMachineIdentityManager("test", cfg, 0)
	if err != nil {
		t.Fatalf("NewMachineIdentityManager: %v", err)
	}

	// Env var must be scrubbed.
	if v := os.Getenv(envVar); v != "" {
		t.Fatalf("env var %s still set to %q after construction", envVar, v)
	}

	tok, err := m.GetToken(context.Background(), "")
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if tok != "tok" {
		t.Fatalf("got token %q, want tok", tok)
	}
}

func TestNewMachineIdentityManager_ClientSecretEnv_FormBody(t *testing.T) {
	const envVar = "ION_TEST_SECRET_FORM"
	t.Setenv(envVar, "form-secret")

	var gotContentType string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotContentType = r.Header.Get("Content-Type")
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if r.FormValue("grant_type") != "client_credentials" {
			t.Errorf("grant_type = %q", r.FormValue("grant_type"))
		}
		if r.FormValue("client_id") != "cid" {
			t.Errorf("client_id = %q", r.FormValue("client_id"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"at","expires_in":300}`)) //nolint:errcheck
	}))
	defer ts.Close()

	cfg := types.OAuthConfig{
		ClientID: "cid",
		TokenURL: ts.URL,
		MachineIdentity: &types.MachineIdentityConfig{
			Source:          "client_secret",
			ClientSecretEnv: envVar,
		},
	}
	m, err := NewMachineIdentityManager("p", cfg, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.GetToken(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if gotContentType != "application/x-www-form-urlencoded" {
		t.Errorf("Content-Type = %q, want application/x-www-form-urlencoded", gotContentType)
	}
}

func TestNewMachineIdentityManager_ClientSecretFile(t *testing.T) {
	dir := t.TempDir()
	secretFile := filepath.Join(dir, "secret.txt")
	if err := os.WriteFile(secretFile, []byte("  file-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		if got := r.FormValue("client_secret"); got != "file-secret" {
			t.Errorf("client_secret = %q, want file-secret (trimmed)", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"ft","expires_in":600}`)) //nolint:errcheck
	}))
	defer ts.Close()

	cfg := types.OAuthConfig{
		ClientID: "cid",
		TokenURL: ts.URL,
		MachineIdentity: &types.MachineIdentityConfig{
			Source:           "client_secret",
			ClientSecretFile: secretFile,
		},
	}
	m, err := NewMachineIdentityManager("p", cfg, 0)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := m.GetToken(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if tok != "ft" {
		t.Fatalf("token = %q, want ft", tok)
	}
}

func TestNewMachineIdentityManager_FederatedAssertion_ReReadsFile(t *testing.T) {
	dir := t.TempDir()
	tokenFile := filepath.Join(dir, "assertion.jwt")
	if err := os.WriteFile(tokenFile, []byte("jwt-v1"), 0600); err != nil {
		t.Fatal(err)
	}

	var assertionsSeen []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		assertionsSeen = append(assertionsSeen, r.FormValue("client_assertion"))
		w.Header().Set("Content-Type", "application/json")
		// Short expiry so cache won't hold.
		w.Write([]byte(`{"access_token":"a","expires_in":1}`)) //nolint:errcheck
	}))
	defer ts.Close()

	cfg := types.OAuthConfig{
		ClientID: "cid",
		TokenURL: ts.URL,
		MachineIdentity: &types.MachineIdentityConfig{
			Source:             "federated_assertion",
			FederatedTokenFile: tokenFile,
		},
	}
	m, err := NewMachineIdentityManager("p", cfg, 100)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.GetToken(context.Background(), ""); err != nil {
		t.Fatal(err)
	}

	// Rotate the file.
	if err := os.WriteFile(tokenFile, []byte("jwt-v2"), 0600); err != nil {
		t.Fatal(err)
	}

	// Wait for cache expiry (threshold=100ms, token expires_in=1s).
	time.Sleep(150 * time.Millisecond)
	// Force cache miss by using different scope.
	if _, err := m.GetTokenWithAudience(context.Background(), "other", ""); err != nil {
		t.Fatal(err)
	}

	if len(assertionsSeen) < 2 {
		t.Fatalf("expected >=2 assertion posts, got %d", len(assertionsSeen))
	}
	if assertionsSeen[0] != "jwt-v1" {
		t.Errorf("first assertion = %q, want jwt-v1", assertionsSeen[0])
	}
	if assertionsSeen[len(assertionsSeen)-1] != "jwt-v2" {
		t.Errorf("last assertion = %q, want jwt-v2", assertionsSeen[len(assertionsSeen)-1])
	}
}

func TestNewMachineIdentityManager_UnsupportedSource(t *testing.T) {
	cfg := types.OAuthConfig{
		MachineIdentity: &types.MachineIdentityConfig{Source: "bogus"},
	}
	_, err := NewMachineIdentityManager("p", cfg, 0)
	if err == nil {
		t.Fatal("expected error for unsupported source")
	}
}

func TestNewMachineIdentityManager_MissingConfig(t *testing.T) {
	cfg := types.OAuthConfig{}
	_, err := NewMachineIdentityManager("p", cfg, 0)
	if err == nil {
		t.Fatal("expected error for nil MachineIdentity")
	}
}

func TestNewMachineIdentityManager_AWSSource_NoBearer(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
	cfg := types.OAuthConfig{
		MachineIdentity: &types.MachineIdentityConfig{
			Source: "aws",
			AWS:    &types.AWSMachineIdentityConfig{Kind: "env"},
		},
	}
	m, err := NewMachineIdentityManager("p", cfg, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.GetToken(context.Background(), "")
	if err == nil {
		t.Fatal("AWS source should error on bearer token request")
	}
	if m.AWSProvider() == nil {
		t.Fatal("AWSProvider() should be non-nil for aws source")
	}
}

func TestNewMachineIdentityManager_BothSecretSources_Error(t *testing.T) {
	cfg := types.OAuthConfig{
		ClientID: "cid",
		TokenURL: "https://example.com/token",
		MachineIdentity: &types.MachineIdentityConfig{
			Source:           "client_secret",
			ClientSecretEnv:  "SOME_VAR",
			ClientSecretFile: "/some/file",
		},
	}
	_, err := NewMachineIdentityManager("p", cfg, 0)
	if err == nil {
		t.Fatal("expected error when both clientSecretEnv and clientSecretFile are set")
	}
}

func TestNewMachineIdentityManager_NeitherSecretSource_Error(t *testing.T) {
	cfg := types.OAuthConfig{
		ClientID: "cid",
		TokenURL: "https://example.com/token",
		MachineIdentity: &types.MachineIdentityConfig{
			Source: "client_secret",
		},
	}
	_, err := NewMachineIdentityManager("p", cfg, 0)
	if err == nil {
		t.Fatal("expected error when neither clientSecretEnv nor clientSecretFile is set")
	}
}
