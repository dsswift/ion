package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// makeUnsignedJWT builds a JWT with the given claims and a fake signature.
// The identity manager intentionally skips signature verification (the token
// arrives directly from the provider's token endpoint over TLS), so a fake
// signature segment is sufficient for claim-parsing tests.
func makeUnsignedJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

// --- PKCE full round-trip ---

// TestStartPKCEFlow_RoundTrip_CapturesFullGrant drives the complete PKCE
// flow against a mock token endpoint and asserts the durable grant halves
// (refresh_token, id_token) are captured -- the exact fields the previous
// implementation discarded. This test fails on the unfixed code, which
// delivered only a bare access-token string.
func TestStartPKCEFlow_RoundTrip_CapturesFullGrant(t *testing.T) {
	idToken := makeUnsignedJWT(t, map[string]any{
		"preferred_username": "josh@example.com",
		"oid":                "oid-123",
	})

	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if r.FormValue("grant_type") != "authorization_code" {
			t.Errorf("grant_type = %q", r.FormValue("grant_type"))
		}
		if r.FormValue("code") != "auth-code-1" {
			t.Errorf("code = %q", r.FormValue("code"))
		}
		if r.FormValue("code_verifier") == "" {
			t.Error("missing code_verifier")
		}
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

	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID: "client-1",
		AuthURL:  "https://login.example.com/authorize",
		TokenURL: tokenSrv.URL,
		Scope:    "openid profile offline_access",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	// Extract state and redirect_uri from the authorization URL, then
	// simulate the provider redirecting the browser to the callback.
	authURL, err := url.Parse(flow.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	q := authURL.Query()
	redirectURI := q.Get("redirect_uri")
	state := q.Get("state")
	if redirectURI == "" || state == "" {
		t.Fatalf("authorization URL missing redirect_uri or state: %s", flow.AuthorizationURL)
	}

	resp, err := http.Get(fmt.Sprintf("%s?code=auth-code-1&state=%s", redirectURI, url.QueryEscape(state)))
	if err != nil {
		t.Fatalf("callback request: %v", err)
	}
	resp.Body.Close()

	select {
	case tok := <-flow.Token:
		if tok.AccessToken != "at-1" {
			t.Errorf("AccessToken = %q", tok.AccessToken)
		}
		if tok.RefreshToken != "rt-1" {
			t.Errorf("RefreshToken = %q; the durable grant half must be captured", tok.RefreshToken)
		}
		if tok.IDToken != idToken {
			t.Errorf("IDToken not captured")
		}
		if tok.Scope != "openid profile offline_access" {
			t.Errorf("Scope = %q", tok.Scope)
		}
		if tok.ExpiresAt.IsZero() || !tok.ExpiresAt.After(time.Now()) {
			t.Errorf("ExpiresAt not computed from expires_in: %v", tok.ExpiresAt)
		}
	case err := <-flow.Err:
		t.Fatalf("flow error: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for token")
	}
}

// TestStartPKCEFlow_RedirectHostAndPath pins the loopback-host control used
// for Entra's literal host matching: a configured "localhost" host and
// custom path must appear verbatim in the redirect URI.
func TestStartPKCEFlow_RedirectHostAndPath(t *testing.T) {
	flow, err := StartPKCEFlow(PKCEFlowConfig{
		ClientID:     "client-1",
		AuthURL:      "https://login.example.com/authorize",
		TokenURL:     "https://login.example.com/token",
		RedirectHost: "localhost",
		RedirectPath: "/auth/done",
	})
	if err != nil {
		t.Fatalf("StartPKCEFlow: %v", err)
	}
	defer flow.Cancel()

	authURL, err := url.Parse(flow.AuthorizationURL)
	if err != nil {
		t.Fatalf("parse auth url: %v", err)
	}
	redirectURI := authURL.Query().Get("redirect_uri")
	u, err := url.Parse(redirectURI)
	if err != nil {
		t.Fatalf("parse redirect uri %q: %v", redirectURI, err)
	}
	if u.Hostname() != "localhost" {
		t.Errorf("redirect host = %q, want localhost (Entra matches the literal spelling)", u.Hostname())
	}
	if u.Path != "/auth/done" {
		t.Errorf("redirect path = %q, want /auth/done", u.Path)
	}
}

// --- Scoped refresh grant ---

// TestDoRefreshTokenGrant_ScopeParameter pins RFC 6749 §6 scope narrowing:
// a non-empty scope is sent with the grant (minting a per-resource token),
// an empty scope is omitted (provider returns the original grant's scope).
func TestDoRefreshTokenGrant_ScopeParameter(t *testing.T) {
	var gotScope atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		// Distinguish "absent" from "empty" -- the empty-scope grant must
		// not send the parameter at all.
		if _, present := r.Form["scope"]; present {
			gotScope.Store(r.FormValue("scope"))
		} else {
			gotScope.Store("<absent>")
		}
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "scoped-at",
			"token_type":   "Bearer",
			"scope":        r.FormValue("scope"),
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	tok, err := doRefreshTokenGrant("client-1", "rt-1", server.URL, "api://downstream/Billing.Read", "", "")
	if err != nil {
		t.Fatalf("scoped grant: %v", err)
	}
	if gotScope.Load() != "api://downstream/Billing.Read" {
		t.Errorf("scope sent = %v, want the requested downstream scope", gotScope.Load())
	}
	if tok.Scope != "api://downstream/Billing.Read" {
		t.Errorf("granted scope not captured: %q", tok.Scope)
	}

	if _, err := doRefreshTokenGrant("client-1", "rt-1", server.URL, "", "", ""); err != nil {
		t.Fatalf("unscoped grant: %v", err)
	}
	if gotScope.Load() != "<absent>" {
		t.Errorf("empty scope must omit the parameter, sent %v", gotScope.Load())
	}
}

// --- IdentityManager ---

func testIdentityManager(t *testing.T, tokenURL string) *IdentityManager {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	return NewIdentityManager("entra", types.OAuthConfig{
		ClientID:         "client-1",
		AuthorizationURL: "https://login.example.com/authorize",
		TokenURL:         tokenURL,
		Scopes:           []string{"openid", "profile", "offline_access"},
	}, 0)
}

func seedGrant(t *testing.T, m *IdentityManager, tok *TokenResponse) {
	t.Helper()
	if err := m.CompleteLogin(tok); err != nil {
		t.Fatalf("CompleteLogin: %v", err)
	}
}

// TestIdentityManager_GetToken_MintsPerScope asserts one refresh token
// mints per-scope access tokens, and that a second request for the same
// scope is served from cache without a network round-trip.
func TestIdentityManager_GetToken_MintsPerScope(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		r.ParseForm()
		scope := r.FormValue("scope")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-for-" + scope,
			"token_type":   "Bearer",
			"scope":        scope,
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	m := testIdentityManager(t, server.URL)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "base-at",
		RefreshToken: "rt-1",
		Scope:        "openid profile offline_access",
		ExpiresAt:    time.Now().Add(time.Hour),
	})

	ctx := context.Background()

	tok, err := m.GetToken(ctx, "api://downstream/Billing.Read")
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if tok != "at-for-api://downstream/Billing.Read" {
		t.Errorf("minted token = %q", tok)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected 1 mint call, got %d", calls.Load())
	}

	// Same scope again: cache hit, no new network call.
	if _, err := m.GetToken(ctx, "api://downstream/Billing.Read"); err != nil {
		t.Fatalf("cached GetToken: %v", err)
	}
	if calls.Load() != 1 {
		t.Errorf("cache miss: %d calls for a fresh cached token", calls.Load())
	}

	// Different scope: a second mint from the same refresh token.
	tok2, err := m.GetToken(ctx, "api://downstream/Departments.Write")
	if err != nil {
		t.Fatalf("second scope GetToken: %v", err)
	}
	if tok2 != "at-for-api://downstream/Departments.Write" {
		t.Errorf("second minted token = %q", tok2)
	}
	if calls.Load() != 2 {
		t.Errorf("expected 2 mint calls, got %d", calls.Load())
	}
}

// TestIdentityManager_GetToken_BaseScopeFromStoredGrant asserts a request
// for the base scope is served from the persisted grant while fresh (no
// mint), and that the base grant's access token is not handed out expired.
func TestIdentityManager_GetToken_BaseScopeFromStoredGrant(t *testing.T) {
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "refreshed-at",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	m := testIdentityManager(t, server.URL)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "base-at",
		RefreshToken: "rt-1",
		Scope:        "openid profile offline_access",
		ExpiresAt:    time.Now().Add(time.Hour),
	})

	tok, err := m.GetToken(context.Background(), "")
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if tok != "base-at" {
		t.Errorf("expected the stored fresh base token, got %q", tok)
	}
	if calls.Load() != 0 {
		t.Errorf("fresh base grant must not trigger a mint, got %d calls", calls.Load())
	}
}

// TestIdentityManager_GetToken_RefreshesExpired asserts an expired base
// grant triggers the refresh grant instead of returning the stale token.
func TestIdentityManager_GetToken_RefreshesExpired(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "refreshed-at",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	m := testIdentityManager(t, server.URL)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "stale-at",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})

	tok, err := m.GetToken(context.Background(), "")
	if err != nil {
		t.Fatalf("GetToken: %v", err)
	}
	if tok != "refreshed-at" {
		t.Errorf("expected refreshed token, got %q (stale token must never be returned)", tok)
	}
}

// TestIdentityManager_RefreshTokenRotation_Persisted asserts a rotated
// refresh token from a mint is written back to the store -- losing it would
// strand the identity on providers that rotate per use.
func TestIdentityManager_RefreshTokenRotation_Persisted(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.FormValue("refresh_token") != "rt-1" && r.FormValue("refresh_token") != "rt-2" {
			t.Errorf("unexpected refresh_token %q", r.FormValue("refresh_token"))
		}
		json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "at-x",
			"refresh_token": "rt-2",
			"token_type":    "Bearer",
			"expires_in":    3600,
		})
	}))
	defer server.Close()

	m := testIdentityManager(t, server.URL)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "base-at",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})

	if _, err := m.GetToken(context.Background(), "api://x/S"); err != nil {
		t.Fatalf("GetToken: %v", err)
	}

	stored, err := m.loadStored()
	if err != nil {
		t.Fatalf("loadStored: %v", err)
	}
	if stored.RefreshToken != "rt-2" {
		t.Errorf("rotated refresh token not persisted: %q", stored.RefreshToken)
	}
}

// TestIdentityManager_Identity_ParsesClaims asserts identity claims come
// from the persisted id_token, preferring oid over sub, and that AttributionValue
// prefers preferred_username.
func TestIdentityManager_Identity_ParsesClaims(t *testing.T) {
	m := testIdentityManager(t, "https://unused.example.com")
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "at",
		RefreshToken: "rt",
		IDToken: makeUnsignedJWT(t, map[string]any{
			"preferred_username": "josh@example.com",
			"name":               "Joshua Sprague",
			"oid":                "oid-123",
			"sub":                "pairwise-sub",
		}),
		ExpiresAt: time.Now().Add(time.Hour),
	})

	id := m.Identity()
	if id == nil {
		t.Fatal("Identity() = nil for a signed-in operator")
	}
	if id.Username != "josh@example.com" {
		t.Errorf("Username = %q", id.Username)
	}
	if id.Subject != "oid-123" {
		t.Errorf("Subject = %q, want the oid claim over sub", id.Subject)
	}
	if id.Name != "Joshua Sprague" {
		t.Errorf("Name = %q", id.Name)
	}
	if id.Provider != "entra" {
		t.Errorf("Provider = %q", id.Provider)
	}
	if id.AttributionValue() != "josh@example.com" {
		t.Errorf("AttributionValue = %q", id.AttributionValue())
	}
}

// TestIdentityManager_SignOut asserts sign-out removes the grant, clears
// the identity, and makes GetToken fail.
func TestIdentityManager_SignOut(t *testing.T) {
	m := testIdentityManager(t, "https://unused.example.com")
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "at",
		RefreshToken: "rt",
		IDToken:      makeUnsignedJWT(t, map[string]any{"oid": "oid-123"}),
		ExpiresAt:    time.Now().Add(time.Hour),
	})

	if !m.SignedIn() {
		t.Fatal("SignedIn() = false after CompleteLogin")
	}
	if err := m.SignOut(); err != nil {
		t.Fatalf("SignOut: %v", err)
	}
	if m.SignedIn() {
		t.Error("SignedIn() = true after SignOut")
	}
	if m.Identity() != nil {
		t.Error("Identity() != nil after SignOut")
	}
	if _, err := m.GetToken(context.Background(), ""); err == nil {
		t.Error("GetToken must fail after SignOut")
	}
}

// TestIdentityManager_GetToken_NoRefreshToken asserts a grant without a
// refresh token yields a clear re-login error once expired, not a silent
// stale token.
func TestIdentityManager_GetToken_NoRefreshToken(t *testing.T) {
	m := testIdentityManager(t, "https://unused.example.com")
	seedGrant(t, m, &TokenResponse{
		AccessToken: "at",
		ExpiresAt:   time.Now().Add(-time.Minute),
	})

	_, err := m.GetToken(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for expired grant with no refresh token")
	}
	if !strings.Contains(err.Error(), "re-login") {
		t.Errorf("error should direct to interactive re-login: %v", err)
	}
}

// --- Generic IdP support: discovery, audience, attribution ---

// TestIdentityManager_OIDCDiscovery pins issuerUrl-based endpoint
// resolution: a provider configured with only issuerUrl + clientId
// resolves its endpoints from /.well-known/openid-configuration, and
// explicitly-configured endpoints are never overwritten by discovery.
func TestIdentityManager_OIDCDiscovery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mux := http.NewServeMux()
	var issuerSrv *httptest.Server
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"issuer":                        issuerSrv.URL,
			"authorization_endpoint":        issuerSrv.URL + "/authorize",
			"token_endpoint":                issuerSrv.URL + "/oauth/token",
			"device_authorization_endpoint": issuerSrv.URL + "/oauth/device/code",
		})
	})
	mux.HandleFunc("/oauth/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "discovered-at",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	})
	issuerSrv = httptest.NewServer(mux)
	defer issuerSrv.Close()

	m := NewIdentityManager("generic", types.OAuthConfig{
		ClientID:  "client-1",
		IssuerURL: issuerSrv.URL,
	}, 0)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "stale",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})

	// GetToken must resolve the token endpoint via discovery, then mint.
	tok, err := m.GetToken(context.Background(), "some.scope")
	if err != nil {
		t.Fatalf("GetToken with discovery: %v", err)
	}
	if tok != "discovered-at" {
		t.Errorf("token = %q; discovery-resolved endpoint not used", tok)
	}

	// Explicit endpoints win over discovery.
	m2 := NewIdentityManager("generic2", types.OAuthConfig{
		ClientID:  "client-1",
		IssuerURL: issuerSrv.URL,
		TokenURL:  "https://explicit.example.com/token",
	}, 0)
	if err := m2.resolveEndpoints(); err != nil {
		t.Fatalf("resolveEndpoints: %v", err)
	}
	if m2.cfg.TokenURL != "https://explicit.example.com/token" {
		t.Errorf("explicit tokenUrl overwritten by discovery: %q", m2.cfg.TokenURL)
	}
	if m2.cfg.AuthorizationURL != issuerSrv.URL+"/authorize" {
		t.Errorf("empty authorizationUrl not filled by discovery: %q", m2.cfg.AuthorizationURL)
	}
}

// TestIdentityManager_AudienceDialects pins the audience/resource
// parameter: sent under "audience" by default, under "resource" when
// configured (RFC 8707), defaulted from config when the request declares
// none, and cached separately per (scope, audience) pair.
func TestIdentityManager_AudienceDialects(t *testing.T) {
	var gotParams atomic.Value
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		r.ParseForm()
		gotParams.Store(map[string]string{
			"audience": r.FormValue("audience"),
			"resource": r.FormValue("resource"),
		})
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": fmt.Sprintf("at-%d", calls.Load()),
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	t.Setenv("HOME", t.TempDir())
	m := NewIdentityManager("auth0ish", types.OAuthConfig{
		ClientID: "client-1",
		TokenURL: server.URL,
		Audience: "https://default.api.example.com",
	}, 0)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "stale",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})

	ctx := context.Background()

	// Default dialect ("audience"), explicit per-request value.
	if _, err := m.GetTokenWithAudience(ctx, "read:things", "https://api-a.example.com"); err != nil {
		t.Fatalf("explicit audience: %v", err)
	}
	if p := gotParams.Load().(map[string]string); p["audience"] != "https://api-a.example.com" || p["resource"] != "" {
		t.Errorf("explicit audience params = %v", p)
	}

	// Empty per-request audience falls back to the configured default.
	if _, err := m.GetTokenWithAudience(ctx, "read:things", ""); err != nil {
		t.Fatalf("default audience: %v", err)
	}
	if p := gotParams.Load().(map[string]string); p["audience"] != "https://default.api.example.com" {
		t.Errorf("default audience params = %v", p)
	}

	// Same scope, different audiences: two distinct cache entries (both
	// minted above); repeating either request now hits the cache.
	before := calls.Load()
	if _, err := m.GetTokenWithAudience(ctx, "read:things", "https://api-a.example.com"); err != nil {
		t.Fatalf("cached audience: %v", err)
	}
	if calls.Load() != before {
		t.Errorf("cache miss: same (scope, audience) pair re-minted")
	}

	// RFC 8707 dialect: the parameter name flips to "resource".
	m2 := NewIdentityManager("rfc8707", types.OAuthConfig{
		ClientID:          "client-1",
		TokenURL:          server.URL,
		AudienceParameter: "resource",
	}, 0)
	seedGrant(t, m2, &TokenResponse{
		AccessToken:  "stale",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Minute),
	})
	if _, err := m2.GetTokenWithAudience(ctx, "read:things", "https://api-b.example.com"); err != nil {
		t.Fatalf("resource dialect: %v", err)
	}
	if p := gotParams.Load().(map[string]string); p["resource"] != "https://api-b.example.com" || p["audience"] != "" {
		t.Errorf("resource dialect params = %v", p)
	}
}

// TestIdentityManager_AttributionClaim pins the configurable attribution
// claim: when set, AttributionValue returns that claim's value instead of
// the preferred_username fallback chain.
func TestIdentityManager_AttributionClaim(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := NewIdentityManager("generic", types.OAuthConfig{
		ClientID:         "client-1",
		TokenURL:         "https://unused.example.com",
		AttributionClaim: "email",
	}, 0)
	seedGrant(t, m, &TokenResponse{
		AccessToken:  "at",
		RefreshToken: "rt",
		IDToken: makeUnsignedJWT(t, map[string]any{
			"preferred_username": "upn@example.com",
			"email":              "attribution@example.com",
			"sub":                "sub-1",
		}),
		ExpiresAt: time.Now().Add(time.Hour),
	})

	id := m.Identity()
	if id == nil {
		t.Fatal("Identity() = nil")
	}
	if id.AttributionValue() != "attribution@example.com" {
		t.Errorf("AttributionValue = %q, want the configured email claim", id.AttributionValue())
	}
}
