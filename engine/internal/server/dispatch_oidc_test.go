package server

// dispatch_oidc_test.go — end-to-end tests for the operator OIDC identity
// commands. Each test goes through the full JSON-decode → dispatch path so
// the wire contract (command validation, event delivery, broadcast
// semantics) is exercised against actual socket input.
//
// Test matrix:
//  1. Commands without a configured identity manager → clear config error.
//  2. oidc_begin_login (PKCE): engine_oidc_login_url event to the requester
//     with the authorization URL; simulated browser redirect completes the
//     exchange; engine_oidc_identity broadcast carries the signed-in claims.
//  3. oidc_identity: signed-out snapshot (oidcSignedIn=false present on the
//     wire despite omitempty — pointer contract).
//  4. oidc_logout: clears the grant and broadcasts the signed-out snapshot.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// oidcTestJWT builds an unsigned JWT carrying the given claims (the engine
// intentionally skips signature verification for tokens received directly
// from the token endpoint).
func oidcTestJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// findOidcEvent scans NDJSON lines for the given engine_oidc_* event type.
func findOidcEvent(t *testing.T, lines []string, eventType string) *types.EngineEvent {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(l, `"`+eventType+`"`) {
			continue
		}
		var wrapper struct {
			Event json.RawMessage `json:"event"`
		}
		if err := json.Unmarshal([]byte(l), &wrapper); err != nil {
			continue
		}
		var evt types.EngineEvent
		if err := json.Unmarshal(wrapper.Event, &evt); err != nil {
			continue
		}
		if evt.Type == eventType {
			return &evt
		}
	}
	return nil
}

func TestDispatchOidc_NoIdentityManagerConfigured(t *testing.T) {
	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	for _, cmd := range []string{"oidc_begin_login", "oidc_logout", "oidc_identity"} {
		sendJSON(t, conn, map[string]interface{}{
			"cmd":       cmd,
			"requestId": "req-" + cmd,
		})
		lines := readLines(t, conn, 1, 2*time.Second)
		found := false
		for _, l := range lines {
			if strings.Contains(l, "req-"+cmd) && strings.Contains(l, "no OIDC identity provider configured") {
				found = true
			}
		}
		if !found {
			t.Errorf("%s without identity manager: expected configuration error result, got %v", cmd, lines)
		}
	}
}

func TestDispatchOidc_PKCELoginRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	idToken := oidcTestJWT(t, map[string]any{
		"preferred_username": "josh@example.com",
		"name":               "Joshua Sprague",
		"oid":                "oid-123",
	})

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "at-1",
			"refresh_token": "rt-1",
			"id_token":      idToken,
			"token_type":    "Bearer",
			"scope":         "openid profile offline_access",
			"expires_in":    3600,
		})
	}))
	defer tokenSrv.Close()

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	srv.SetIdentityManager(auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         tokenSrv.URL,
		Scopes:           []string{"openid", "profile", "offline_access"},
	}, 0))

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "oidc_begin_login",
		"requestId": "req-login",
	})

	lines := readLines(t, conn, 2, 3*time.Second)
	loginEvt := findOidcEvent(t, lines, types.EventOidcLoginURL)
	if loginEvt == nil {
		t.Fatalf("no engine_oidc_login_url event delivered, lines: %v", lines)
	}
	if loginEvt.OidcAuthorizationURL == "" {
		t.Fatal("engine_oidc_login_url missing oidcAuthorizationUrl for PKCE flow")
	}

	// Simulate the browser: hit the engine's loopback callback with the
	// code + state from the authorization URL.
	authURL, err := url.Parse(loginEvt.OidcAuthorizationURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	q := authURL.Query()
	resp, err := http.Get(fmt.Sprintf("%s?code=code-1&state=%s", q.Get("redirect_uri"), url.QueryEscape(q.Get("state"))))
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	resp.Body.Close()

	// Completion broadcasts the signed-in identity snapshot.
	var identityEvt *types.EngineEvent
	deadline := time.Now().Add(3 * time.Second)
	for identityEvt == nil && time.Now().Before(deadline) {
		more := readLines(t, conn, 1, 500*time.Millisecond)
		identityEvt = findOidcEvent(t, more, types.EventOidcIdentity)
	}
	if identityEvt == nil {
		t.Fatal("no engine_oidc_identity broadcast after login completion")
	}
	if identityEvt.OidcSignedIn == nil || !*identityEvt.OidcSignedIn {
		t.Error("identity snapshot must carry oidcSignedIn=true")
	}
	if identityEvt.OidcUsername != "josh@example.com" {
		t.Errorf("oidcUsername = %q", identityEvt.OidcUsername)
	}
	if identityEvt.OidcSubject != "oid-123" {
		t.Errorf("oidcSubject = %q", identityEvt.OidcSubject)
	}
	if identityEvt.OidcProvider != "entra" {
		t.Errorf("oidcProvider = %q", identityEvt.OidcProvider)
	}
}

func TestDispatchOidc_IdentitySnapshotSignedOut(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	srv.SetIdentityManager(auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         "https://login.example.com/token",
	}, 0))

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "oidc_identity",
		"requestId": "req-id",
	})

	lines := readLines(t, conn, 2, 2*time.Second)
	evt := findOidcEvent(t, lines, types.EventOidcIdentity)
	if evt == nil {
		t.Fatalf("no engine_oidc_identity event, lines: %v", lines)
	}
	// The signed-out snapshot must still carry the boolean on the wire
	// (pointer defeats omitempty) so consumers can replace their view.
	if evt.OidcSignedIn == nil {
		t.Fatal("oidcSignedIn absent from signed-out snapshot; pointer contract broken")
	}
	if *evt.OidcSignedIn {
		t.Error("oidcSignedIn = true with no stored grant")
	}
	if evt.OidcUsername != "" || evt.OidcSubject != "" {
		t.Error("signed-out snapshot must not carry identity claims")
	}
}

func TestDispatchOidc_TokenMint(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-for-" + r.FormValue("scope"),
			"token_type":   "Bearer",
			"scope":        r.FormValue("scope"),
			"expires_in":   3600,
		})
	}))
	defer mint.Close()

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	im := auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         mint.URL,
	}, 0)
	srv.SetIdentityManager(im)
	if err := im.CompleteLogin(&auth.TokenResponse{
		AccessToken:  "base-at",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute), // force a mint
	}); err != nil {
		t.Fatalf("seed grant: %v", err)
	}

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "oidc_token",
		"requestId": "req-tok",
		"oidcScope": "api://corp/Telemetry.Write",
	})

	lines := readLines(t, conn, 1, 3*time.Second)
	found := false
	for _, l := range lines {
		if strings.Contains(l, "req-tok") && strings.Contains(l, "at-for-api://corp/Telemetry.Write") {
			found = true
		}
	}
	if !found {
		t.Errorf("oidc_token result missing scoped access token, lines: %v", lines)
	}
}

func TestDispatchOidc_Logout(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	srv := newShortPathTestServer(t, mb)
	im := auth.NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         "https://login.example.com/token",
	}, 0)
	srv.SetIdentityManager(im)

	// Seed a signed-in grant directly through the manager.
	if err := im.CompleteLogin(&auth.TokenResponse{
		AccessToken:  "at",
		RefreshToken: "rt",
		IDToken:      oidcTestJWT(t, map[string]any{"preferred_username": "josh@example.com", "oid": "oid-1"}),
		ExpiresAt:    time.Now().Add(time.Hour),
	}); err != nil {
		t.Fatalf("seed grant: %v", err)
	}

	conn := dialServer(t, srv)
	t.Cleanup(func() { conn.Close() })

	sendJSON(t, conn, map[string]interface{}{
		"cmd":       "oidc_logout",
		"requestId": "req-out",
	})

	lines := readLines(t, conn, 2, 2*time.Second)
	evt := findOidcEvent(t, lines, types.EventOidcIdentity)
	if evt == nil {
		t.Fatalf("no engine_oidc_identity broadcast after logout, lines: %v", lines)
	}
	if evt.OidcSignedIn == nil || *evt.OidcSignedIn {
		t.Error("logout broadcast must carry oidcSignedIn=false")
	}
	if im.SignedIn() {
		t.Error("grant still present after oidc_logout")
	}
}
