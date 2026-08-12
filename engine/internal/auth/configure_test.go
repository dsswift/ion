package auth

import (
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

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
