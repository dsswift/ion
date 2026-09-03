package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestReconcileAtStartup_UpgradesLegacyGrantToCurrentVersion pins the fix for a
// grant written by an older engine (no identity version, expired id_token): at
// startup the engine silently refreshes it with the existing refresh token,
// verifies the fresh id_token, and re-persists at the current schema with the
// identity snapshot — no interactive re-login. Reverting the reconcile leaves
// the grant below currentIdentityVersion and Identity() nil.
func TestReconcileAtStartup_UpgradesLegacyGrantToCurrentVersion(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	fixture := newVerifierFixture(t)

	idClaims := map[string]any{
		"iss":                fixture.issuer,
		"aud":                "client-app",
		"sub":                "sub-1",
		"oid":                "oid-1",
		"preferred_username": "josh@example.com",
		"name":               "Josh",
		"exp":                time.Now().Add(time.Hour).Unix(),
		"iat":                time.Now().Unix(),
	}
	var refreshUsed string
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		refreshUsed = r.FormValue("refresh_token")
		if err := json.NewEncoder(w).Encode(map[string]any{
			"access_token":  "fresh-at",
			"refresh_token": "rt-2",
			"expires_in":    3600,
			"scope":         "openid profile offline_access",
			"id_token":      fixture.token(t, idClaims),
		}); err != nil {
			t.Errorf("encode token response: %v", err)
		}
	}))
	defer tokenServer.Close()

	m := NewIdentityManager("entra", types.OAuthConfig{
		ClientID:  "client-app",
		IssuerURL: fixture.issuer,
		TokenURL:  tokenServer.URL,
		Scopes:    []string{"openid", "profile", "offline_access"},
	}, 0)
	// Skip Ion's own strict discovery (the fixture's discovery doc omits
	// token_endpoint); the JWKS verifier still resolves via IssuerURL.
	m.endpointsResolved = true

	// Write a legacy (v0) grant directly: no identity_version, expired access
	// token, a live refresh token.
	legacy := oauthToken{
		AccessToken:  "stale-at",
		RefreshToken: "rt-1",
		ExpiresAt:    time.Now().Add(-time.Hour),
		Scope:        "openid profile offline_access",
	}
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("marshal legacy grant: %v", err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(encoded)); err != nil {
		t.Fatalf("seed legacy grant: %v", err)
	}

	if err := m.ReconcileAtStartup(context.Background()); err != nil {
		t.Fatalf("ReconcileAtStartup: %v", err)
	}
	if refreshUsed != "rt-1" {
		t.Fatalf("refresh_token used = %q, want the legacy rt-1", refreshUsed)
	}

	stored, err := m.loadStored()
	if err != nil {
		t.Fatalf("load stored grant after reconcile: %v", err)
	}
	if stored.IdentityVersion != currentIdentityVersion {
		t.Fatalf("stored IdentityVersion = %d, want %d", stored.IdentityVersion, currentIdentityVersion)
	}
	if stored.RefreshToken != "rt-2" {
		t.Fatalf("stored refresh token = %q, want rotated rt-2", stored.RefreshToken)
	}
	if stored.PersistedIdentity == nil || stored.PersistedIdentity.Username != "josh@example.com" {
		t.Fatalf("stored PersistedIdentity = %#v, want snapshot with username", stored.PersistedIdentity)
	}
	id := m.Identity()
	if id == nil || id.Username != "josh@example.com" {
		t.Fatalf("Identity() = %#v, want restored operator identity", id)
	}
}

// TestRenewNow_ProviderRejectionLosesVerification pins the one path that clears
// the operator identity short of an explicit sign-out: an affirmative provider
// rejection (invalid_grant) of the refresh token. This is a genuine loss of
// verification, distinct from a lapsed freshness window, and it publishes a
// verification_lost snapshot.
func TestRenewNow_ProviderRejectionLosesVerification(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := json.NewEncoder(w).Encode(map[string]any{
			"error": "invalid_grant", "error_description": "refresh token expired or revoked",
		}); err != nil {
			t.Errorf("encode rejection: %v", err)
		}
	}))
	defer tokenServer.Close()

	m := NewIdentityManager("entra", types.OAuthConfig{ClientID: "c", TokenURL: tokenServer.URL}, 0)
	m.endpointsResolved = true
	past := time.Now().Add(-time.Hour)
	stored := oauthToken{
		AccessToken: "stale", RefreshToken: "rt-dead", ExpiresAt: past, Scope: "openid",
		IdentityVersion:   currentIdentityVersion,
		PersistedIdentity: &persistedIdentity{Username: "josh@example.com", ExpiresAt: past},
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatalf("marshal grant: %v", err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(encoded)); err != nil {
		t.Fatalf("seed grant: %v", err)
	}

	var lost atomic.Int32
	unsubscribe := SubscribeContextIdentityChanges(func(change ContextIdentityChange) {
		if change.Reason == "verification_lost" {
			lost.Add(1)
		}
	})
	defer unsubscribe()

	if err := m.renewNow(context.Background(), true); err == nil {
		t.Fatal("renewNow: want error on provider rejection")
	}
	if id := m.Identity(); id != nil {
		t.Fatalf("Identity() = %#v, want nil after provider rejection", id)
	}
	if lost.Load() != 1 {
		t.Fatalf("verification_lost notifications = %d, want 1", lost.Load())
	}
}

// TestIdentity_HydratesFromPersistedSnapshotWithoutNetwork pins that a v2 grant
// restores the operator identity at load from its persisted snapshot, with no
// token-endpoint round-trip, when the access token is still fresh.
func TestIdentity_HydratesFromPersistedSnapshotWithoutNetwork(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer tokenServer.Close()

	future := time.Now().Add(time.Hour)
	stored := oauthToken{
		AccessToken:     "fresh-at",
		RefreshToken:    "rt-1",
		ExpiresAt:       future,
		Scope:           "openid",
		IdentityVersion: currentIdentityVersion,
		PersistedIdentity: &persistedIdentity{
			Subject: "oid-1", Username: "josh@example.com", Name: "Josh", ExpiresAt: future,
		},
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		t.Fatalf("marshal grant: %v", err)
	}

	writer := NewIdentityManager("entra", types.OAuthConfig{ClientID: "c", TokenURL: tokenServer.URL}, 0)
	if err := writer.fs.SetKey(writer.storeKey(), string(encoded)); err != nil {
		t.Fatalf("seed v2 grant: %v", err)
	}

	// A fresh manager over the same store hydrates identity without any I/O.
	reader := NewIdentityManager("entra", types.OAuthConfig{ClientID: "c", TokenURL: tokenServer.URL}, 0)
	id := reader.Identity()
	if id == nil || id.Username != "josh@example.com" {
		t.Fatalf("Identity() = %#v, want hydrated snapshot", id)
	}
	if got := tokenCalls.Load(); got != 0 {
		t.Fatalf("token endpoint calls = %d, want 0 (fresh v2 grant hydrates without network)", got)
	}
}
