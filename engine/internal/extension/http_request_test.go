package extension

// http_request_test.go — behavior pins for the pre-authenticated outbound
// HTTP surface (DoOperatorHTTPRequest, shared by Context.HTTPRequest and
// the ext/http_request RPC).
//
// Test matrix:
//  1. The minted operator token arrives at the target as the Authorization
//     header — the core feature contract.
//  2. An extension-supplied Authorization header is overwritten (the
//     wrapper owns the credential, never the extension).
//  3. The response struct carries no token anywhere (leak check on the
//     serialized response).
//  4. Private/reserved addresses are blocked by default and reachable only
//     with the explicit allowPrivateNetwork declaration.
//  5. Non-http(s) schemes are rejected.
//  6. No configured operator → clear configuration error.
//  7. A declared scope mints a per-resource token via the refresh grant.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// setupOperator installs a signed-in operator whose base grant is fresh
// (access token "base-at") and whose refresh grant mints "at-for-<scope>"
// via the given token endpoint. Cleans up the registry on test end.
func setupOperator(t *testing.T, tokenURL string) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	m := auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         tokenURL,
	}, 0)
	if err := m.CompleteLogin(&auth.TokenResponse{
		AccessToken:  "base-at",
		RefreshToken: "rt-1",
		Scope:        "openid profile offline_access",
		ExpiresAt:    time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("seed grant: %v", err)
	}
	auth.SetOperator(m)
	t.Cleanup(func() { auth.SetOperator(nil) })
}

// mintServer returns a token endpoint that mints "at-for-<scope>".
func mintServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		scope := r.FormValue("scope")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-for-" + scope,
			"token_type":   "Bearer",
			"scope":        scope,
			"expires_in":   3600,
		})
	}))
}

func TestOperatorHTTP_InjectsBearerToken(t *testing.T) {
	var gotAuth atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	setupOperator(t, "https://unused.example.com")

	resp, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL:                 target.URL,
		Method:              "POST",
		Body:                `{"hello":"world"}`,
		AllowPrivateNetwork: true, // httptest binds loopback
	})
	if err != nil {
		t.Fatalf("DoOperatorHTTPRequest: %v", err)
	}
	if gotAuth.Load() != "Bearer base-at" {
		t.Errorf("Authorization = %q, want the minted operator token", gotAuth.Load())
	}
	if resp.Status != http.StatusOK {
		t.Errorf("Status = %d", resp.Status)
	}
	if resp.Body != `{"ok":true}` {
		t.Errorf("Body = %q", resp.Body)
	}
}

func TestOperatorHTTP_OverwritesExtensionAuthorization(t *testing.T) {
	var gotAuth atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	setupOperator(t, "https://unused.example.com")

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL:                 target.URL,
		Headers:             map[string]string{"Authorization": "Bearer attacker-controlled"},
		AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("DoOperatorHTTPRequest: %v", err)
	}
	if gotAuth.Load() != "Bearer base-at" {
		t.Errorf("Authorization = %q; extension-supplied credential must be overwritten", gotAuth.Load())
	}
}

func TestOperatorHTTP_ResponseCarriesNoToken(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("payload"))
	}))
	defer target.Close()

	setupOperator(t, "https://unused.example.com")

	resp, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL:                 target.URL,
		AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("DoOperatorHTTPRequest: %v", err)
	}

	// Serialize the exact struct the RPC hands back to the extension and
	// assert the operator token appears nowhere in it.
	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "base-at") {
		t.Errorf("operator token leaked into the extension-visible response: %s", raw)
	}
}

func TestOperatorHTTP_BlocksPrivateAddressesByDefault(t *testing.T) {
	setupOperator(t, "https://unused.example.com")

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: "http://127.0.0.1:9/never",
	})
	if err == nil {
		t.Fatal("expected private-address block without allowPrivateNetwork")
	}
	if !strings.Contains(err.Error(), "allowPrivateNetwork") {
		t.Errorf("block error should name the opt-out: %v", err)
	}
}

func TestOperatorHTTP_RejectsNonHTTPSchemes(t *testing.T) {
	setupOperator(t, "https://unused.example.com")

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: "ftp://example.com/file",
	})
	if err == nil || !strings.Contains(err.Error(), "http/https") {
		t.Errorf("expected scheme rejection, got %v", err)
	}
}

func TestOperatorHTTP_NoOperatorConfigured(t *testing.T) {
	auth.SetOperator(nil)
	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: "https://api.example.com/x",
	})
	if err == nil || !strings.Contains(err.Error(), "identityProvider") {
		t.Errorf("expected configuration error, got %v", err)
	}
}

func TestOperatorHTTP_MintsScopedToken(t *testing.T) {
	var gotAuth atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer target.Close()

	mint := mintServer(t)
	defer mint.Close()

	setupOperator(t, mint.URL)

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL:                 target.URL,
		Scope:               "api://downstream/Billing.Read",
		AllowPrivateNetwork: true,
	})
	if err != nil {
		t.Fatalf("DoOperatorHTTPRequest: %v", err)
	}
	if gotAuth.Load() != "Bearer at-for-api://downstream/Billing.Read" {
		t.Errorf("Authorization = %q, want the per-scope minted token", gotAuth.Load())
	}
}
