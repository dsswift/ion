package extension

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestAuthenticatedHTTP_MachineClientCredentialsEndToEnd(t *testing.T) {
	const secretEnv = "ION_HTTP_M2M_SECRET"
	t.Setenv(secretEnv, "engine-only-secret")

	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse token request: %v", err)
		}
		if got := r.FormValue("grant_type"); got != "client_credentials" {
			t.Errorf("grant_type = %q", got)
		}
		if got := r.FormValue("client_secret"); got != "engine-only-secret" {
			t.Errorf("client_secret = %q", got)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "machine-at", "expires_in": 3600})
	}))
	defer tokenServer.Close()

	machine, err := auth.NewMachineIdentityManager("workload", types.OAuthConfig{
		ClientID: "client", TokenURL: tokenServer.URL,
		MachineIdentity: &types.MachineIdentityConfig{Source: "client_secret", ClientSecretEnv: secretEnv},
	}, 0)
	if err != nil {
		t.Fatalf("machine manager: %v", err)
	}
	auth.SetTokenProvider(machine)
	t.Cleanup(func() { auth.SetTokenProvider(nil) })

	var downstreamAuth string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	response, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: target.URL, Scope: "api://target/.default", AllowPrivateNetwork: true,
		Headers: map[string]string{"Authorization": "Bearer extension-value"},
	})
	if err != nil {
		t.Fatalf("authenticated request: %v", err)
	}
	if downstreamAuth != "Bearer machine-at" {
		t.Fatalf("downstream Authorization = %q", downstreamAuth)
	}
	wire, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"machine-at", "engine-only-secret"} {
		if strings.Contains(string(wire), forbidden) {
			t.Fatalf("credential leaked into extension response: %s", wire)
		}
	}
}

func TestAuthenticatedHTTP_DoesNotFollowRedirect(t *testing.T) {
	setupOperator(t, "https://unused.example.com")
	var reached bool
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	defer final.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()

	response, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: redirect.URL, AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != http.StatusTemporaryRedirect || reached {
		t.Fatalf("redirect followed: status=%d reached=%v", response.Status, reached)
	}
}
