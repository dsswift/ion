package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const egressSecretEnv = "ION_TEST_EGRESS_CLIENT_SECRET"

func machineEntry(tokenURL string) types.OAuthConfig {
	return types.OAuthConfig{
		ClientID: "egress-client",
		TokenURL: tokenURL,
		MachineIdentity: &types.MachineIdentityConfig{
			Source:          "client_secret",
			ClientSecretEnv: egressSecretEnv,
		},
	}
}

func TestResolveEgressTokenSource(t *testing.T) {
	t.Setenv(egressSecretEnv, "s3cret")
	authCfg := &types.AuthConfig{
		IdentityProvider: "operator",
		OAuth: map[string]types.OAuthConfig{
			"operator":       {ClientID: "op", TokenURL: "https://idp.example.com/token"},
			"other-operator": {ClientID: "op2", TokenURL: "https://idp.example.com/token"},
			"telemetry-ship": machineEntry("https://idp.example.com/token"),
		},
	}
	cases := []struct {
		name, provider, wantName, wantKind string
	}{
		{"unset uses identity provider", "", "operator", "identity_provider"},
		{"identity provider reuses its instance", "operator", "operator", "identity_provider"},
		{"missing entry falls back", "nope", "operator", "identity_provider"},
		{"interactive entry falls back", "other-operator", "operator", "identity_provider"},
		{"machine identity entry", "telemetry-ship", "telemetry-ship", "machine_identity"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := resolveEgressTokenSource(authCfg, &types.LoggingConfig{EgressTokenProvider: tc.provider})
			if src.name != tc.wantName || src.kind != tc.wantKind {
				t.Fatalf("got name=%q kind=%q, want name=%q kind=%q", src.name, src.kind, tc.wantName, tc.wantKind)
			}
		})
	}
}

// The identity-provider source is looked up at flush time, so it follows the
// registry rather than capturing whatever was installed at startup.
func TestResolveEgressTokenSourceIdentityIsLive(t *testing.T) {
	src := resolveEgressTokenSource(nil, nil)
	prev := auth.CurrentTokenProvider()
	t.Cleanup(func() { auth.SetTokenProvider(prev) })
	auth.SetTokenProvider(nil)
	if src.provider() != nil {
		t.Fatal("no identity provider installed, want nil")
	}
}

// A headless engine with a client_secret machine identity named by
// egressTokenProvider must put its minted token on shipped egress requests.
func TestEgressMachineIdentityAuthorizesFlush(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dir)
	t.Setenv(egressSecretEnv, "s3cret")

	var tokenForm sync.Map
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		for _, key := range []string{"grant_type", "client_id", "client_secret", "scope"} {
			tokenForm.Store(key, r.PostForm.Get(key))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "egress-token-123", "token_type": "Bearer", "expires_in": 3600}) //nolint:errcheck // test server
	}))
	t.Cleanup(tokenSrv.Close)

	var mu sync.Mutex
	var authHeaders []string
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.Close)

	cfg := &types.EngineRuntimeConfig{
		Auth: &types.AuthConfig{OAuth: map[string]types.OAuthConfig{"telemetry-ship": machineEntry(tokenSrv.URL)}},
		Logging: &types.LoggingConfig{
			LogDir:                dir,
			OutputMode:            "file",
			EgressTargets:         []string{"otel"},
			EgressOtel:            &types.OtelConfig{Enabled: true, Endpoint: sink.URL},
			EgressFlushIntervalMs: int64(time.Hour / time.Millisecond),
			EgressTokenScope:      "api://egress-app/.default",
			EgressTokenProvider:   "telemetry-ship",
		},
	}
	utils.ConfigureLogging(cfg.Logging)
	t.Cleanup(func() {
		utils.ShutdownLogEgress(5 * time.Second)
		utils.SetEgressAuthHeaderProvider(nil)
	})
	installEgressAuth(cfg)
	if _, set := os.LookupEnv(egressSecretEnv); set {
		t.Fatal("machine identity must consume and remove its secret env var")
	}

	utils.LogWithFields(utils.LevelInfo, "test", "egress-auth-marker", nil)
	if !utils.ShutdownLogEgress(10 * time.Second) {
		t.Fatal("egress drain did not finish")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(authHeaders) == 0 {
		t.Fatal("no egress request reached the sink")
	}
	for _, h := range authHeaders {
		if h != "Bearer egress-token-123" {
			t.Fatalf("egress Authorization = %q, want the machine identity token", h)
		}
	}
	want := map[string]string{"grant_type": "client_credentials", "client_id": "egress-client", "client_secret": "s3cret", "scope": "api://egress-app/.default"}
	for key, value := range want {
		if got, _ := tokenForm.Load(key); got != value {
			t.Errorf("token request %s = %v, want %q", key, got, value)
		}
	}
}
