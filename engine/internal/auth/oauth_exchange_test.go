package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The authorization-code exchange must carry the same scope the authorization
// request carried.
//
// RFC 6749 makes scope optional on this grant, and providers that infer it
// from the code accept its absence -- which is why this shipped broken and no
// test caught it. Microsoft Entra rejects it: an authorization request naming
// a resource scope, exchanged without one, fails with "AADSTS28003: Provided
// value for the input parameter scope cannot be empty". The user has already
// authenticated and consented by then, so the failure surfaces in the browser
// after a successful sign-in and reads like a broken app registration.
func TestExchangeCodeForToken_SendsScope(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		got = r.Form.Get("scope")
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "refresh_token": "rt", "token_type": "Bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer srv.Close()

	scope := "openid profile offline_access https://api.example.com/Directory.Read"
	cfg := PKCEFlowConfig{ClientID: "client", TokenURL: srv.URL, Scope: scope}

	if _, err := exchangeCodeForToken(cfg, "code", "verifier", "http://localhost:1234/callback"); err != nil {
		t.Fatalf("exchangeCodeForToken: %v", err)
	}
	if got != scope {
		t.Errorf("scope sent = %q, want %q", got, scope)
	}
}

// An empty scope must stay absent rather than being sent as "". A provider
// that infers scope from the code treats an explicit empty value as a request
// for no scopes at all.
func TestExchangeCodeForToken_OmitsEmptyScope(t *testing.T) {
	var present bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		_, present = r.Form["scope"]
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "token_type": "Bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer srv.Close()

	cfg := PKCEFlowConfig{ClientID: "client", TokenURL: srv.URL}
	if _, err := exchangeCodeForToken(cfg, "code", "verifier", "http://localhost:1234/callback"); err != nil {
		t.Fatalf("exchangeCodeForToken: %v", err)
	}
	if present {
		t.Error("scope was sent for a config that declares none")
	}
}

// The exchange must reproduce what the authorization request asked for. A
// mismatch is how a resource scope gets silently dropped between the two legs
// of the same flow.
func TestAuthorizationAndExchangeAgreeOnScope(t *testing.T) {
	scope := "openid profile offline_access api://app-id/Telemetry.Write"
	cfg := PKCEFlowConfig{
		ClientID: "client",
		AuthURL:  "https://login.example.com/authorize",
		Scope:    scope,
	}

	authURL, err := buildAuthorizationURL(cfg, "http://localhost:1234/callback", "challenge", "state")
	if err != nil {
		t.Fatalf("buildAuthorizationURL: %v", err)
	}
	if !strings.Contains(authURL, "scope=") {
		t.Fatalf("authorization URL carries no scope: %s", authURL)
	}

	var exchanged string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		exchanged = r.Form.Get("scope")
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "token_type": "Bearer", "expires_in": 3600,
		}); err != nil {
			t.Errorf("encode: %v", err)
		}
	}))
	defer srv.Close()

	cfg.TokenURL = srv.URL
	if _, err := exchangeCodeForToken(cfg, "code", "verifier", "http://localhost:1234/callback"); err != nil {
		t.Fatalf("exchangeCodeForToken: %v", err)
	}
	if exchanged != scope {
		t.Errorf("exchange sent scope %q, authorization asked for %q", exchanged, scope)
	}
}
