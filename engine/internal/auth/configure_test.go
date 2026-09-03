package auth

import (
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// captureAuthLogs installs a log sink for the duration of a test and returns a
// snapshot function. It serializes access so the sink is race-safe and restores
// the previous log level and sink on cleanup.
func captureAuthLogs(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var msgs []string
	prevLevel := utils.GetLevel()
	utils.SetLevel(utils.LevelDebug)
	utils.SetTestSink(func(_ utils.LogLevel, _, msg string, _ map[string]any, _, _ string) {
		mu.Lock()
		msgs = append(msgs, msg)
		mu.Unlock()
	})
	t.Cleanup(func() {
		utils.SetTestSink(nil)
		utils.SetLevel(prevLevel)
	})
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(msgs))
		copy(out, msgs)
		return out
	}
}

const issuerlessWarnMsg = "operator identity provider has no issuerUrl; identity verification cannot run"

// TestConfigureIdentityProviders_OperatorNoIssuerWarns asserts that an operator
// provider configured with an explicit tokenUrl but no issuerUrl is still
// configured (boot must not fail — token minting stays available), and that the
// engine warns loudly at boot rather than letting the "issuerUrl is required"
// failure hide in later renewal retries.
func TestConfigureIdentityProviders_OperatorNoIssuerWarns(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)
	logs := captureAuthLogs(t)

	cfg := &types.AuthConfig{
		IdentityProvider: "entra",
		OAuth: map[string]types.OAuthConfig{
			"entra": {
				ClientID: "cid",
				TokenURL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
				Scopes:   []string{"openid"},
			},
		},
	}
	mgr, err := ConfigureIdentityProviders(cfg)
	if err != nil {
		t.Fatalf("boot must not fail for an issuerless operator provider: %v", err)
	}
	if mgr == nil {
		t.Fatal("expected non-nil manager; token minting stays available without issuerUrl")
	}
	if !containsMsg(logs(), issuerlessWarnMsg) {
		t.Errorf("expected boot warning %q, got %v", issuerlessWarnMsg, logs())
	}
}

// TestConfigureIdentityProviders_OperatorWithIssuerNoWarn asserts the warning is
// absent when issuerUrl is present — verification can run, so there is nothing
// to warn about. This is the negative that makes the guard a real regression
// test: without the guard the positive case cannot warn, and without this case
// the guard could warn unconditionally.
func TestConfigureIdentityProviders_OperatorWithIssuerNoWarn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)
	logs := captureAuthLogs(t)

	cfg := &types.AuthConfig{
		IdentityProvider: "entra",
		OAuth: map[string]types.OAuthConfig{
			"entra": {
				ClientID:  "cid",
				TokenURL:  "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
				IssuerURL: "https://login.microsoftonline.com/tenant/v2.0",
				Scopes:    []string{"openid"},
			},
		},
	}
	if _, err := ConfigureIdentityProviders(cfg); err != nil {
		t.Fatal(err)
	}
	if containsMsg(logs(), issuerlessWarnMsg) {
		t.Errorf("did not expect issuerless warning when issuerUrl is set, got %v", logs())
	}
}

func containsMsg(msgs []string, want string) bool {
	for _, m := range msgs {
		if m == want {
			return true
		}
	}
	return false
}

func TestConfigureIdentityProviders_NilConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	SetTokenProvider(&mockTokenProvider{token: "stale"})
	defer SetTokenProvider(nil)

	mgr, err := ConfigureIdentityProviders(nil)
	if err != nil {
		t.Fatal(err)
	}
	if mgr != nil {
		t.Error("expected nil manager for nil config")
	}
	if CurrentTokenProvider() != nil {
		t.Error("expected token provider to be cleared")
	}
}

func TestConfigureIdentityProviders_EmptyIdentityProvider(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	SetTokenProvider(&mockTokenProvider{token: "stale"})
	defer SetTokenProvider(nil)

	cfg := &types.AuthConfig{IdentityProvider: ""}
	mgr, err := ConfigureIdentityProviders(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if mgr != nil {
		t.Error("expected nil manager for empty identity provider")
	}
	if CurrentTokenProvider() != nil {
		t.Error("expected token provider to be cleared")
	}
}

func TestConfigureIdentityProviders_RequiredWithoutProvider(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)

	_, err := ConfigureIdentityProviders(&types.AuthConfig{RequireOperatorIdentity: true})
	if err == nil || err.Error() != "auth.requireOperatorIdentity requires auth.identityProvider" {
		t.Fatalf("expected required-provider error, got %v", err)
	}
}

func TestConfigureIdentityProviders_RequiredRejectsMachineIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)

	_, err := ConfigureIdentityProviders(&types.AuthConfig{
		IdentityProvider:        "machine",
		RequireOperatorIdentity: true,
		OAuth: map[string]types.OAuthConfig{
			"machine": {MachineIdentity: &types.MachineIdentityConfig{Source: "client_secret"}},
		},
	})
	if err == nil || !strings.Contains(err.Error(), "requires an interactive operator provider") {
		t.Fatalf("expected machine-identity rejection, got %v", err)
	}
}

func TestConfigureIdentityProviders_MissingOAuthEntry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)

	cfg := &types.AuthConfig{
		IdentityProvider: "entra",
		OAuth:            map[string]types.OAuthConfig{},
	}
	_, err := ConfigureIdentityProviders(cfg)
	if err == nil {
		t.Fatal("expected error when named provider is missing from oauth map")
	}
}

func TestConfigureIdentityProviders_OperatorIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)

	cfg := &types.AuthConfig{
		IdentityProvider: "entra",
		OAuth: map[string]types.OAuthConfig{
			"entra": {
				ClientID: "cid",
				TokenURL: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
				Scopes:   []string{"openid"},
			},
		},
	}
	mgr, err := ConfigureIdentityProviders(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if mgr == nil {
		t.Fatal("expected non-nil IdentityManager for operator identity")
	}
	if CurrentTokenProvider() == nil {
		t.Error("expected token provider to be set")
	}
}

func TestConfigureIdentityProviders_MachineIdentity(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	envVar := "ION_TEST_CONFIGURE_SECRET"
	t.Setenv(envVar, "secret-val")
	defer SetTokenProvider(nil)

	cfg := &types.AuthConfig{
		IdentityProvider: "machine",
		OAuth: map[string]types.OAuthConfig{
			"machine": {
				ClientID: "cid",
				TokenURL: "https://example.com/token",
				Scopes:   []string{"api"},
				MachineIdentity: &types.MachineIdentityConfig{
					Source:          "client_secret",
					ClientSecretEnv: envVar,
				},
			},
		},
	}
	mgr, err := ConfigureIdentityProviders(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if mgr != nil {
		t.Error("expected nil IdentityManager for machine identity")
	}
	if CurrentTokenProvider() == nil {
		t.Error("expected token provider to be set for machine bearer source")
	}
	if v := os.Getenv(envVar); v != "" {
		t.Errorf("env var %s should be scrubbed, got %q", envVar, v)
	}
}

func TestConfigureIdentityProviders_AWSMachine(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "SECRET")
	defer SetTokenProvider(nil)
	defer SetAWSCredentialsProvider(nil)

	cfg := &types.AuthConfig{
		IdentityProvider: "aws",
		OAuth: map[string]types.OAuthConfig{
			"aws": {
				MachineIdentity: &types.MachineIdentityConfig{
					Source: "aws",
					AWS:    &types.AWSMachineIdentityConfig{Kind: "env"},
				},
			},
		},
	}
	mgr, err := ConfigureIdentityProviders(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if mgr != nil {
		t.Error("expected nil IdentityManager for AWS machine identity")
	}
	if CurrentAWSCredentialsProvider() == nil {
		t.Error("expected AWS provider to be set")
	}
}

func TestConfigureIdentityProviders_InvalidMachineConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	defer SetTokenProvider(nil)

	cfg := &types.AuthConfig{
		IdentityProvider: "broken",
		OAuth: map[string]types.OAuthConfig{
			"broken": {
				MachineIdentity: &types.MachineIdentityConfig{
					Source: "bogus_source",
				},
			},
		},
	}
	_, err := ConfigureIdentityProviders(cfg)
	if err == nil {
		t.Fatal("expected error for unsupported machine source")
	}
}
