package main

// announce_test.go — tests for server-announced trust per channel
// (manifest C7): announce parsing, TrustStore lifecycle, OIDCRegistry
// allowlisting and per-call audience override, and the announced-trust
// validation path end to end against a real signed JWT.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// ---- parseRelayAnnounce ----

func TestParseRelayAnnounce_ValidTrust(t *testing.T) {
	frame := `{"type":"relay_announce","trust":{"issuer":"https://login.example.com","audience":"api://server","scope":"Studio.Access"}}`
	trust, ok := parseRelayAnnounce([]byte(frame))
	if !ok {
		t.Fatal("parseRelayAnnounce returned ok=false for a well-formed announcement")
	}
	if trust.Issuer != "https://login.example.com" {
		t.Errorf("Issuer = %q", trust.Issuer)
	}
	if trust.Audience != "api://server" {
		t.Errorf("Audience = %q", trust.Audience)
	}
	if trust.Scope != "Studio.Access" {
		t.Errorf("Scope = %q", trust.Scope)
	}
	if trust.Pairing {
		t.Error("Pairing should be false for a regular announcement")
	}
}

func TestParseRelayAnnounce_PairingChannel(t *testing.T) {
	expiresAt := time.Now().Add(5 * time.Minute).UnixMilli()
	frame, err := json.Marshal(map[string]any{
		"type": "relay_announce",
		"trust": map[string]any{
			"pairing":   true,
			"expiresAt": expiresAt,
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	trust, ok := parseRelayAnnounce(frame)
	if !ok {
		t.Fatal("parseRelayAnnounce returned ok=false for a well-formed pairing announcement")
	}
	if !trust.Pairing {
		t.Error("Pairing should be true")
	}
	if trust.ExpiresAt.UnixMilli() != expiresAt {
		t.Errorf("ExpiresAt = %v, want %v", trust.ExpiresAt.UnixMilli(), expiresAt)
	}
}

func TestParseRelayAnnounce_NotAnAnnouncement(t *testing.T) {
	tests := []string{
		`{"type":"some_other_frame","data":"x"}`,
		`not json at all`,
		`{"type":"relay_announce","trust":{"audience":"api://server"}}`,            // missing issuer
		`{"type":"relay_announce","trust":{"issuer":"https://login.example.com"}}`, // missing audience
	}
	for _, frame := range tests {
		if _, ok := parseRelayAnnounce([]byte(frame)); ok {
			t.Errorf("parseRelayAnnounce(%q) = ok=true, want false", frame)
		}
	}
}

// ---- TrustStore ----

func TestTrustStore_SetGetClear(t *testing.T) {
	store := NewTrustStore()

	if _, ok := store.Get("chan-1"); ok {
		t.Fatal("expected no trust for an unset channel")
	}

	trust := ChannelTrust{Issuer: "https://login.example.com", Audience: "api://server"}
	store.Set("chan-1", trust)

	got, ok := store.Get("chan-1")
	if !ok {
		t.Fatal("expected trust after Set")
	}
	if got.Issuer != trust.Issuer {
		t.Errorf("Issuer = %q, want %q", got.Issuer, trust.Issuer)
	}

	store.Clear("chan-1")
	if _, ok := store.Get("chan-1"); ok {
		t.Error("expected no trust after Clear")
	}
}

func TestTrustStore_SetReplacesNotMerges(t *testing.T) {
	store := NewTrustStore()
	store.Set("chan-1", ChannelTrust{Issuer: "https://a.example.com", Audience: "aud-a"})
	store.Set("chan-1", ChannelTrust{Issuer: "https://b.example.com", Audience: "aud-b"})

	got, ok := store.Get("chan-1")
	if !ok {
		t.Fatal("expected trust")
	}
	if got.Issuer != "https://b.example.com" {
		t.Errorf("Issuer = %q, want the SECOND announcement to win outright", got.Issuer)
	}
}

func TestTrustStore_MarkUsed(t *testing.T) {
	store := NewTrustStore()
	store.Set("pairing:abc", ChannelTrust{Pairing: true, ExpiresAt: time.Now().Add(5 * time.Minute)})

	got, _ := store.Get("pairing:abc")
	if got.Used {
		t.Fatal("expected Used=false before MarkUsed")
	}

	store.MarkUsed("pairing:abc")
	got, _ = store.Get("pairing:abc")
	if !got.Used {
		t.Error("expected Used=true after MarkUsed")
	}
}

// ---- OIDCRegistry ----

func TestOIDCRegistry_UntrustedIssuerRefused(t *testing.T) {
	registry := NewOIDCRegistry("https://trusted.example.com")
	_, err := registry.Validate("any-token", "https://untrusted.example.com", "aud", "")
	if err != errIssuerNotTrusted {
		t.Errorf("got err=%v, want errIssuerNotTrusted", err)
	}
}

func TestOIDCRegistry_EmptyAllowlistTrustsNothing(t *testing.T) {
	registry := NewOIDCRegistry("")
	_, err := registry.Validate("any-token", "https://anything.example.com", "aud", "")
	if err != errIssuerNotTrusted {
		t.Errorf("got err=%v, want errIssuerNotTrusted (empty allowlist trusts no issuer)", err)
	}
}

func TestOIDCRegistry_TrustedIssuerValidatesRealJWT(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	registry := NewOIDCRegistry(srv.URL)

	claims := standardClaims(srv.URL, "announced-audience")
	tokenStr := makeJWT(t, key, claims)

	identity, err := registry.Validate(tokenStr, srv.URL, "announced-audience", "")
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if identity.Subject != "oid-abc-456" {
		t.Errorf("Subject = %q", identity.Subject)
	}
}

func TestOIDCRegistry_SameIssuerDifferentAudiencePerCall(t *testing.T) {
	// Two channels can announce the same issuer with different audiences;
	// the cached per-issuer OIDCConfig must validate each call against ITS
	// OWN audience, not whatever audience the first call happened to pass.
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)
	registry := NewOIDCRegistry(srv.URL)

	tokenForA := makeJWT(t, key, standardClaims(srv.URL, "audience-a"))
	if _, err := registry.Validate(tokenForA, srv.URL, "audience-a", ""); err != nil {
		t.Fatalf("Validate audience-a: %v", err)
	}

	tokenForB := makeJWT(t, key, standardClaims(srv.URL, "audience-b"))
	if _, err := registry.Validate(tokenForB, srv.URL, "audience-b", ""); err != nil {
		t.Fatalf("Validate audience-b: %v", err)
	}

	// A token for audience-a must NOT validate against audience-b.
	if _, err := registry.Validate(tokenForA, srv.URL, "audience-b", ""); err == nil {
		t.Error("expected audience mismatch, got success")
	}
}

// ---- validateAgainstAnnouncedTrust ----

func TestValidateAgainstAnnouncedTrust_NoAnnouncementFallsThrough(t *testing.T) {
	store := NewTrustStore()
	req := newBearerRequest(t, "some-token")

	_, announced := validateAgainstAnnouncedTrust(req, "chan-unannounced", store, NewOIDCRegistry(""))
	if announced {
		t.Error("expected announced=false for a channel with no announcement")
	}
}

func TestValidateAgainstAnnouncedTrust_UntrustedIssuerRefused(t *testing.T) {
	store := NewTrustStore()
	store.Set("chan-1", ChannelTrust{Issuer: "https://untrusted.example.com", Audience: "aud"})
	req := newBearerRequest(t, "some-token")

	outcome, announced := validateAgainstAnnouncedTrust(req, "chan-1", store, NewOIDCRegistry(""))
	if !announced {
		t.Fatal("expected announced=true for a channel with an announcement")
	}
	if outcome.reason != authFailureIssuerNotTrusted {
		t.Errorf("reason = %q, want %q", outcome.reason, authFailureIssuerNotTrusted)
	}
}

func TestValidateAgainstAnnouncedTrust_ValidJWTAccepted(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	store := NewTrustStore()
	store.Set("chan-1", ChannelTrust{Issuer: srv.URL, Audience: "aud"})

	tokenStr := makeJWT(t, key, standardClaims(srv.URL, "aud"))
	req := newBearerRequest(t, tokenStr)

	outcome, announced := validateAgainstAnnouncedTrust(req, "chan-1", store, NewOIDCRegistry(srv.URL))
	if !announced {
		t.Fatal("expected announced=true")
	}
	if outcome.reason != "" {
		t.Fatalf("unexpected reason: %q", outcome.reason)
	}
	if outcome.identity == nil || outcome.identity.Subject != "oid-abc-456" {
		t.Errorf("identity = %+v", outcome.identity)
	}
}

func TestValidateAgainstAnnouncedTrust_PairingExpired(t *testing.T) {
	store := NewTrustStore()
	store.Set("pairing:abc", ChannelTrust{Pairing: true, ExpiresAt: time.Now().Add(-time.Minute)})
	req := newBearerRequest(t, "some-token")

	outcome, announced := validateAgainstAnnouncedTrust(req, "pairing:abc", store, NewOIDCRegistry(""))
	if !announced {
		t.Fatal("expected announced=true")
	}
	if outcome.reason != authFailurePairingExpired {
		t.Errorf("reason = %q, want %q", outcome.reason, authFailurePairingExpired)
	}
}

func TestValidateAgainstAnnouncedTrust_PairingSingleUse(t *testing.T) {
	store := NewTrustStore()
	store.Set("pairing:abc", ChannelTrust{Pairing: true, ExpiresAt: time.Now().Add(5 * time.Minute)})
	req := newBearerRequest(t, "irrelevant-pairing-has-no-bearer-check")

	// First join succeeds -- a pairing channel's identity guarantee comes
	// from the DH handshake the peers run over the forwarded frames, not
	// from a bearer the relay checks, so no OIDCRegistry is needed here.
	outcome, announced := validateAgainstAnnouncedTrust(req, "pairing:abc", store, nil)
	if !announced || outcome.reason != "" {
		t.Fatalf("first join: announced=%v reason=%q", announced, outcome.reason)
	}
	if !outcome.pairing {
		t.Error("expected outcome.pairing=true")
	}
	store.MarkUsed("pairing:abc")

	// Second join is refused regardless of what's presented.
	outcome, announced = validateAgainstAnnouncedTrust(req, "pairing:abc", store, nil)
	if !announced {
		t.Fatal("expected announced=true")
	}
	if outcome.reason != authFailurePairingExpired {
		t.Errorf("second join reason = %q, want %q (single use)", outcome.reason, authFailurePairingExpired)
	}
}

// newBearerRequest builds a minimal *http.Request carrying the given bearer
// token, for validateAgainstAnnouncedTrust tests that don't need a real
// server round trip.
func newBearerRequest(t *testing.T, bearer string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "http://relay.local/v1/channel/chan-1", nil)
	req.Header.Set("Authorization", "Bearer "+bearer)
	return req
}
