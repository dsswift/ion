package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// A federated workload (AKS workload identity) takes its client ID from the
// variable the webhook sets, sends it on the token request, and leaves the
// variable in place for other SDKs in the process.
func TestClientIDEnv_FederatedAssertionUsesEnvClientID(t *testing.T) {
	const envVar = "ION_TEST_AZURE_CLIENT_ID"
	t.Setenv(envVar, "workload-client")
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("assertion-jwt\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var gotClientID, gotAssertion string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		gotClientID, gotAssertion = r.FormValue("client_id"), r.FormValue("client_assertion")
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"access_token":"at","expires_in":300}`)) //nolint:errcheck // test server
	}))
	defer ts.Close()

	cfg := types.OAuthConfig{
		ClientIDEnv: envVar,
		TokenURL:    ts.URL,
		MachineIdentity: &types.MachineIdentityConfig{
			Source:             "federated_assertion",
			FederatedTokenFile: tokenFile,
		},
	}
	m, err := NewMachineIdentityManager("ship-a", cfg, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.GetToken(context.Background(), "api://collector/.default"); err != nil {
		t.Fatal(err)
	}
	if gotClientID != "workload-client" || gotAssertion != "assertion-jwt" {
		t.Errorf("client_id = %q, client_assertion = %q", gotClientID, gotAssertion)
	}
	if os.Getenv(envVar) != "workload-client" {
		t.Error("clientIdEnv variable was removed; a client id is not a secret and stays set")
	}
}

func TestClientIDEnv_Rejections(t *testing.T) {
	const envVar = "ION_TEST_CLIENT_ID_UNSET"
	t.Setenv(envVar, "")
	federated := &types.MachineIdentityConfig{Source: "federated_assertion", FederatedTokenFile: "/nonexistent"}
	for name, tc := range map[string]struct {
		cfg  types.OAuthConfig
		want string
	}{
		"empty variable":    {types.OAuthConfig{ClientIDEnv: envVar, TokenURL: "http://x", MachineIdentity: federated}, "is empty"},
		"both set":          {types.OAuthConfig{ClientID: "c", ClientIDEnv: envVar, TokenURL: "http://x", MachineIdentity: federated}, "mutually exclusive"},
		"assignment syntax": {types.OAuthConfig{ClientIDEnv: "AZURE_CLIENT_ID=abc", TokenURL: "http://x", MachineIdentity: federated}, "environment variable name"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewMachineIdentityManager("p", tc.cfg, 0)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

// Without clientIdEnv the literal clientId is used unchanged, and resolving
// an already-resolved config is a no-op.
func TestClientIDEnv_UnsetKeepsLiteralClientID(t *testing.T) {
	cfg := types.OAuthConfig{ClientID: "literal"}
	got, err := withResolvedClientID("p", cfg)
	if err != nil || got.ClientID != "literal" || got.ClientIDEnv != "" {
		t.Fatalf("got %+v, %v", got, err)
	}
	t.Setenv("ION_TEST_CLIENT_ID_ONCE", "from-env")
	once, err := withResolvedClientID("p", types.OAuthConfig{ClientIDEnv: "ION_TEST_CLIENT_ID_ONCE"})
	if err != nil {
		t.Fatal(err)
	}
	twice, err := withResolvedClientID("p", once)
	if err != nil || twice.ClientID != "from-env" {
		t.Fatalf("second resolve = %+v, %v", twice, err)
	}
}

// The interactive operator provider reads clientIdEnv too.
func TestClientIDEnv_OperatorProvider(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ION_TEST_OPERATOR_CLIENT_ID", "operator-client")
	cfg := &types.AuthConfig{IdentityProvider: "op", OAuth: map[string]types.OAuthConfig{
		"op": {ClientIDEnv: "ION_TEST_OPERATOR_CLIENT_ID", TokenURL: "http://x", AuthorizationURL: "http://x"},
	}}
	manager, err := ConfigureIdentityProviders(cfg)
	t.Cleanup(func() { SetTokenProvider(nil); SetContextIdentityProvider(nil) })
	if err != nil || manager == nil {
		t.Fatalf("configure: %v", err)
	}
	if manager.cfg.ClientID != "operator-client" {
		t.Errorf("operator client id = %q", manager.cfg.ClientID)
	}
	cfg.OAuth["op"] = types.OAuthConfig{ClientIDEnv: "ION_TEST_OPERATOR_CLIENT_ID_MISSING", TokenURL: "http://x"}
	if _, err := ConfigureIdentityProviders(cfg); err == nil {
		t.Error("an empty clientIdEnv variable must fail the operator provider")
	}
}
