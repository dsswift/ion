package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	jose "github.com/go-jose/go-jose/v4"
)

type verifierFixture struct {
	issuer string
	key    *rsa.PrivateKey
	server *httptest.Server
}

func newVerifierFixture(t *testing.T) *verifierFixture {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate rsa key: %v", err)
	}
	fixture := &verifierFixture{key: key}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			if err := json.NewEncoder(w).Encode(map[string]any{
				"issuer": fixture.issuer, "jwks_uri": fixture.issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"},
			}); err != nil {
				t.Errorf("encode discovery: %v", err)
			}
		case "/keys":
			key := jose.JSONWebKey{Key: &fixture.key.PublicKey, KeyID: "test-key", Algorithm: "RS256", Use: "sig"}
			if err := json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{key}}); err != nil {
				t.Errorf("encode jwks: %v", err)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	fixture.issuer = fixture.server.URL
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *verifierFixture) token(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: f.key}, (&jose.SignerOptions{}).WithHeader("kid", "test-key"))
	if err != nil {
		t.Fatalf("new signer: %v", err)
	}
	raw, err := signer.Sign(payload)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	compact, err := raw.CompactSerialize()
	if err != nil {
		t.Fatalf("serialize token: %v", err)
	}
	return compact
}

func TestOIDCVerifier_ValidTokenPreservesClaims(t *testing.T) {
	fixture := newVerifierFixture(t)
	verifier, err := newOIDCVerifier(fixture.issuer, "client-1")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	token := fixture.token(t, map[string]any{
		"iss": fixture.issuer, "sub": "subject", "aud": "client-1", "exp": time.Now().Add(time.Hour).Unix(), "nbf": time.Now().Add(-time.Minute).Unix(),
		"oid": "object", "preferred_username": "user@example.com", "name": "User", "groups": []any{"group-a"}, "nested": map[string]any{"enabled": true}, "number": 7, "nil": nil, "nonce": "nonce-1",
	})
	identity, err := verifier.verify(context.Background(), token, "nonce-1")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if identity.Subject != "object" || identity.Username != "user@example.com" || identity.Name != "User" {
		t.Fatalf("normalized identity = %#v", identity)
	}
	groups, ok := identity.Claims["groups"].([]any)
	if !ok || len(groups) != 1 || groups[0] != "group-a" {
		t.Fatalf("groups claim = %#v", identity.Claims["groups"])
	}
	identity.Claims["nested"].(map[string]any)["enabled"] = false
	copy := cloneOperatorIdentity(identity)
	if copy.Claims["nested"].(map[string]any)["enabled"] != false {
		t.Fatal("identity clone did not preserve claims")
	}
}

func TestOIDCVerifier_RejectsInvalidClaims(t *testing.T) {
	fixture := newVerifierFixture(t)
	verifier, err := newOIDCVerifier(fixture.issuer, "client-1")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	valid := func(claims map[string]any) map[string]any {
		if _, ok := claims["iss"]; !ok {
			claims["iss"] = fixture.issuer
		}
		if _, ok := claims["sub"]; !ok {
			claims["sub"] = "subject"
		}
		if _, ok := claims["aud"]; !ok {
			claims["aud"] = "client-1"
		}
		if _, ok := claims["exp"]; !ok {
			claims["exp"] = time.Now().Add(time.Hour).Unix()
		}
		return claims
	}
	for name, claims := range map[string]map[string]any{
		"wrong_audience": valid(map[string]any{"aud": "other"}),
		"expired":        valid(map[string]any{"exp": time.Now().Add(-time.Hour).Unix()}),
		"wrong_nonce":    valid(map[string]any{"nonce": "other"}),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := verifier.verify(context.Background(), fixture.token(t, claims), "expected")
			if err == nil {
				t.Fatal("verification unexpectedly succeeded")
			}
		})
	}
}

func TestOIDCVerifier_RejectsOversizedClaims(t *testing.T) {
	fixture := newVerifierFixture(t)
	verifier, err := newOIDCVerifier(fixture.issuer, "client-1")
	if err != nil {
		t.Fatalf("new verifier: %v", err)
	}
	claims := map[string]any{"iss": fixture.issuer, "sub": "subject", "aud": "client-1", "exp": time.Now().Add(time.Hour).Unix(), "large": base64.RawStdEncoding.EncodeToString(make([]byte, maxContextIdentityClaimBytes))}
	if _, err := verifier.verify(context.Background(), fixture.token(t, claims), ""); err == nil {
		t.Fatal("oversized claims unexpectedly verified")
	}
}

// TestContextIdentityNotDiscardedOnExpiry pins the contract that a lapsed
// id_token freshness window never discards the operator's identity by time
// alone. The engine keeps serving the known identity (and renews the grant in
// the background); it does not go nil and does not publish verification_lost.
func TestContextIdentityNotDiscardedOnExpiry(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	manager := NewIdentityManager("test", types.OAuthConfig{}, 0)
	manager.mu.Lock()
	manager.identity = &OperatorIdentity{Provider: "test", Username: "user@example.com"}
	manager.identityExpiry = time.Now().Add(-time.Second)
	manager.identityResolved = true
	manager.mu.Unlock()

	var lost atomic.Int32
	unsubscribe := SubscribeContextIdentityChanges(func(change ContextIdentityChange) {
		if change.Reason == "verification_lost" {
			lost.Add(1)
		}
	})
	defer unsubscribe()

	got := manager.ContextIdentity()
	if got == nil {
		t.Fatal("expired ContextIdentity() = nil, want the known identity retained")
	}
	if got.Username != "user@example.com" {
		t.Fatalf("ContextIdentity().Username = %q, want retained identity", got.Username)
	}
	if again := manager.ContextIdentity(); again == nil {
		t.Fatal("repeated expired ContextIdentity() = nil, want identity still retained")
	}
	if lost.Load() != 0 {
		t.Fatalf("verification_lost notifications = %d, want 0 (time alone must not discard identity)", lost.Load())
	}
}

func TestContextIdentityChangesUseDefensiveSnapshots(t *testing.T) {
	unsubscribed := make(chan struct{})
	unsubscribe := SubscribeContextIdentityChanges(func(change ContextIdentityChange) {
		if change.Identity == nil || change.Identity.Claims["nested"].(map[string]any)["enabled"] != true {
			t.Errorf("unexpected published identity: %#v", change.Identity)
		}
		change.Identity.Claims["nested"].(map[string]any)["enabled"] = false
		close(unsubscribed)
	})
	defer unsubscribe()

	identity := &ContextIdentity{Kind: "operator", Provider: "test", Claims: map[string]any{"nested": map[string]any{"enabled": true}}}
	publishContextIdentityChange(ContextIdentityChange{Identity: identity, Reason: "signed_in"})
	<-unsubscribed
	if identity.Claims["nested"].(map[string]any)["enabled"] != true {
		t.Fatal("subscriber mutated publisher identity")
	}
}

func TestContextIdentityClaimLimit(t *testing.T) {
	claims := map[string]any{"large": base64.RawStdEncoding.EncodeToString(make([]byte, maxContextIdentityClaimBytes))}
	if _, err := cloneClaims(claims); err == nil {
		t.Fatal("oversized claims unexpectedly cloned")
	}
}
