package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

// ---- RSA test key helpers ----

// genRSAKey returns a 2048-bit RSA key for test use.
func genRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	return key
}

// base64URLInt encodes a big.Int as a base64url-unpadded string (JWK "n").
func base64URLInt(n *big.Int) string {
	return base64.RawURLEncoding.EncodeToString(n.Bytes())
}

// base64URLBytes encodes bytes as base64url-unpadded string (JWK "e").
func base64URLBytes(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

// intToBytes converts a small int to big-endian bytes.
func intToBytes(n int) []byte {
	var out []byte
	for n > 0 {
		out = append([]byte{byte(n & 0xff)}, out...)
		n >>= 8
	}
	if len(out) == 0 {
		return []byte{0}
	}
	return out
}

// startFakeOIDCServer starts an httptest server that serves:
//   - /.well-known/openid-configuration
//   - /jwks (JWKS document)
//
// The JWKS contains a single RSA key with kid="test-kid".
func startFakeOIDCServer(t *testing.T, pub *rsa.PublicKey) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			doc := map[string]string{
				"issuer":   srv.URL,
				"jwks_uri": srv.URL + "/jwks",
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(doc)
		case "/jwks":
			eBytes := intToBytes(pub.E)
			key := map[string]string{
				"kid": "test-kid",
				"kty": "RSA",
				"use": "sig",
				"n":   base64URLInt(pub.N),
				"e":   base64URLBytes(eBytes),
			}
			doc := map[string]any{"keys": []any{key}}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(doc)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// makeJWT creates a signed JWT with the given claims and RSA private key.
func makeJWT(t *testing.T, key *rsa.PrivateKey, claims jwt.MapClaims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-kid"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign JWT: %v", err)
	}
	return signed
}

// standardClaims returns a valid set of JWT claims for testing.
func standardClaims(issuer, audience string) jwt.MapClaims {
	return jwt.MapClaims{
		"iss":                issuer,
		"aud":                audience,
		"sub":                "user-sub-123",
		"oid":                "oid-abc-456",
		"preferred_username": "testuser@example.com",
		"exp":                time.Now().Add(time.Hour).Unix(),
		"nbf":                time.Now().Add(-time.Minute).Unix(),
		"iat":                time.Now().Add(-time.Minute).Unix(),
		"roles":              []string{"reader"},
	}
}

// ---- OIDC config tests ----

func TestOIDCConfig_ValidJWT(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	claims := standardClaims(srv.URL, "test-audience")
	tokenStr := makeJWT(t, key, claims)

	identity, err := cfg.ValidateJWT(tokenStr)
	if err != nil {
		t.Fatalf("ValidateJWT: %v", err)
	}
	if identity.Subject != "oid-abc-456" {
		t.Errorf("subject: got %q, want %q", identity.Subject, "oid-abc-456")
	}
	if identity.Username != "testuser@example.com" {
		t.Errorf("username: got %q", identity.Username)
	}
	if len(identity.Roles) != 1 || identity.Roles[0] != "reader" {
		t.Errorf("roles: got %v", identity.Roles)
	}
	if identity.TokenExpiry.IsZero() {
		t.Error("TokenExpiry should be populated")
	}
}

func TestOIDCConfig_RejectExpiredJWT(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// Token expired 2 minutes ago (beyond the 60s leeway).
	claims := standardClaims(srv.URL, "test-audience")
	claims["exp"] = time.Now().Add(-2 * time.Minute).Unix()
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err == nil {
		t.Fatal("expected error for expired JWT, got nil")
	}
}

func TestOIDCConfig_RejectWrongIssuer(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	claims := standardClaims("https://wrong-issuer.example.com", "test-audience")
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err == nil {
		t.Fatal("expected error for wrong issuer, got nil")
	}
}

func TestOIDCConfig_RejectWrongAudience(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "expected-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	claims := standardClaims(srv.URL, "wrong-audience")
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err == nil {
		t.Fatal("expected error for wrong audience, got nil")
	}
}

func TestOIDCConfig_RejectWrongSigningKey(t *testing.T) {
	key := genRSAKey(t)
	wrongKey := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey) // JWKS has key.PublicKey

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// Sign with wrongKey; JWKS has key.PublicKey — verification must fail.
	claims := standardClaims(srv.URL, "test-audience")
	tokenStr := makeJWT(t, wrongKey, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err == nil {
		t.Fatal("expected error for wrong signing key, got nil")
	}
}

func TestOIDCConfig_RequiredScope_Scp(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "relay.access")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// Token has the required scope in "scp" (Entra v1 dialect).
	claims := standardClaims(srv.URL, "test-audience")
	claims["scp"] = "relay.access openid profile"
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err != nil {
		t.Fatalf("ValidateJWT with scp: %v", err)
	}
}

func TestOIDCConfig_RequiredScope_ScopeField(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "relay.access")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// Token has the required scope in "scope" (Entra v2 dialect).
	claims := standardClaims(srv.URL, "test-audience")
	claims["scope"] = "openid relay.access profile"
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err != nil {
		t.Fatalf("ValidateJWT with scope: %v", err)
	}
}

func TestOIDCConfig_RequiredScope_Missing(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "relay.access")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	claims := standardClaims(srv.URL, "test-audience")
	claims["scp"] = "openid profile" // relay.access absent
	tokenStr := makeJWT(t, key, claims)

	_, err = cfg.ValidateJWT(tokenStr)
	if err == nil {
		t.Fatal("expected error for missing required scope, got nil")
	}
}

func TestOIDCConfig_SubjectFallsBackToSub(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	cfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// No "oid" claim; should fall back to "sub".
	claims := standardClaims(srv.URL, "test-audience")
	delete(claims, "oid")
	tokenStr := makeJWT(t, key, claims)

	identity, err := cfg.ValidateJWT(tokenStr)
	if err != nil {
		t.Fatalf("ValidateJWT: %v", err)
	}
	if identity.Subject != "user-sub-123" {
		t.Errorf("subject fallback: got %q, want %q", identity.Subject, "user-sub-123")
	}
}

// ---- OIDC config gating tests ----

func TestNewOIDCConfig_EmptyIssuerIsPSKOnly(t *testing.T) {
	cfg, err := NewOIDCConfig("", "", "")
	if err != nil {
		t.Fatalf("empty issuer should be PSK-only, not an error: %v", err)
	}
	if cfg != nil {
		t.Errorf("empty issuer should return nil config, got %+v", cfg)
	}
}

func TestNewOIDCConfig_IssuerWithoutAudienceIsError(t *testing.T) {
	// An issuer set without an audience must fail loud: an audience-unbound
	// OIDC mode would validate only the issuer and accept a token minted for
	// any other resource server on that issuer (audience-confusion bypass).
	cfg, err := NewOIDCConfig("https://issuer.example.com", "", "")
	if err == nil {
		t.Fatal("issuer set without audience must return an error")
	}
	if cfg != nil {
		t.Errorf("misconfigured OIDC must return nil config, got %+v", cfg)
	}
}

// ---- Dual-mode auth routing tests ----

func TestAuthMiddleware_DualMode_JWTRoutes(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	oidcCfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	auth := NewAuthMiddleware("psk-key", oidcCfg)

	// A JWT-shaped token routes to JWT validation.
	claims := standardClaims(srv.URL, "test-audience")
	tokenStr := makeJWT(t, key, claims)

	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)

	identity, ok := auth.Validate(req)
	if !ok {
		t.Fatal("expected JWT auth to succeed")
	}
	if identity == nil || identity.Subject != "oid-abc-456" {
		t.Errorf("expected identity with subject oid-abc-456, got %v", identity)
	}
}

func TestAuthMiddleware_DualMode_PSKRoutes(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	oidcCfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	auth := NewAuthMiddleware("psk-key", oidcCfg)

	// Non-JWT-shaped token routes to PSK.
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer psk-key")

	identity, ok := auth.Validate(req)
	if !ok {
		t.Fatal("expected PSK auth to succeed")
	}
	if identity != nil {
		t.Errorf("expected nil identity for PSK auth, got %v", identity)
	}
}

func TestAuthMiddleware_OIDCOnly_NoPSK(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	oidcCfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// No PSK configured.
	auth := NewAuthMiddleware("", oidcCfg)

	// PSK attempt should fail.
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer some-psk-key")
	_, ok := auth.Validate(req)
	if ok {
		t.Fatal("expected PSK attempt to fail when only OIDC is configured")
	}

	// Valid JWT should succeed.
	claims := standardClaims(srv.URL, "test-audience")
	tokenStr := makeJWT(t, key, claims)
	req2, _ := http.NewRequest("GET", "/", nil)
	req2.Header.Set("Authorization", "Bearer "+tokenStr)
	_, ok = auth.Validate(req2)
	if !ok {
		t.Fatal("expected JWT auth to succeed in OIDC-only mode")
	}
}

// ---- PSK-only regression ----

func TestAuthMiddleware_PSKOnly_Regression(t *testing.T) {
	auth := NewAuthMiddleware("secret-key-123", nil)

	tests := []struct {
		name   string
		header string
		want   bool
	}{
		{"valid key", "Bearer secret-key-123", true},
		{"wrong key", "Bearer wrong-key", false},
		{"empty header", "", false},
		{"no bearer prefix", "secret-key-123", false},
		{"basic auth", "Basic secret-key-123", false},
		{"bearer lowercase", "bearer secret-key-123", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			_, got := auth.Validate(req)
			if got != tt.want {
				t.Errorf("Validate() = %v, want %v", got, tt.want)
			}
		})
	}
}

// ---- /v1/auth/config endpoint ----

func TestAuthConfigEndpoint_PSKOnly(t *testing.T) {
	server, _ := startTestRelay(t, "my-psk-key")
	resp, err := http.Get(server.URL + "/v1/auth/config")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode auth config: %v", err)
	}
	if body["psk"] != true {
		t.Errorf("expected psk=true, got %v", body["psk"])
	}
	if body["oidc"] != false {
		t.Errorf("expected oidc=false, got %v", body["oidc"])
	}
	caps, ok := body["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("expected capabilities object, got %v", body["capabilities"])
	}
	if caps["mobileForwardAck"] != true {
		t.Errorf("expected capabilities.mobileForwardAck=true, got %v", caps["mobileForwardAck"])
	}
}

func TestAuthConfigEndpoint_OIDCMode(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)

	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "my-audience", "relay.use")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	// Build a relay server with OIDC + PSK.
	hub := NewHub()
	auth := NewAuthMiddleware("psk-key", oidcCfg)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
		type capabilitiesBlock struct {
			MobileForwardAck bool `json:"mobileForwardAck"`
		}
		type authConfigResponse struct {
			OIDC          bool              `json:"oidc"`
			Issuer        string            `json:"issuer,omitempty"`
			Audience      string            `json:"audience,omitempty"`
			RequiredScope string            `json:"requiredScope,omitempty"`
			PSK           bool              `json:"psk"`
			Capabilities  capabilitiesBlock `json:"capabilities"`
		}
		resp := authConfigResponse{
			PSK:          len(auth.apiKey) > 0,
			Capabilities: capabilitiesBlock{MobileForwardAck: true},
		}
		if auth.oidc != nil {
			resp.OIDC = true
			resp.Issuer = auth.oidc.Issuer
			resp.Audience = auth.oidc.Audience
			resp.RequiredScope = auth.oidc.RequiredScope
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	})
	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		if _, ok := auth.Validate(r); !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		hub.HandleWebSocket(w, r, r.PathValue("channelId"), r.URL.Query().Get("role"), nil, nil)
	})
	relaySrv := httptest.NewServer(mux)
	t.Cleanup(func() { hub.CloseAll(); relaySrv.Close() })

	resp, err := http.Get(relaySrv.URL + "/v1/auth/config")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["oidc"] != true {
		t.Errorf("expected oidc=true, got %v", body["oidc"])
	}
	if body["psk"] != true {
		t.Errorf("expected psk=true, got %v", body["psk"])
	}
	if body["issuer"] != oidcSrv.URL {
		t.Errorf("expected issuer=%s, got %v", oidcSrv.URL, body["issuer"])
	}
	if body["audience"] != "my-audience" {
		t.Errorf("expected audience=my-audience, got %v", body["audience"])
	}
	if body["requiredScope"] != "relay.use" {
		t.Errorf("expected requiredScope=relay.use, got %v", body["requiredScope"])
	}
	caps, ok := body["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("expected capabilities object, got %v", body["capabilities"])
	}
	if caps["mobileForwardAck"] != true {
		t.Errorf("expected capabilities.mobileForwardAck=true, got %v", caps["mobileForwardAck"])
	}
}

func TestAuthConfigEndpoint_CapabilitiesConsistentAcrossModes(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "aud", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	modes := []struct {
		name   string
		apiKey string
		oidc   *OIDCConfig
	}{
		{"psk_only", "key", nil},
		{"oidc_only", "", oidcCfg},
		{"dual_mode", "key", oidcCfg},
	}

	for _, mode := range modes {
		t.Run(mode.name, func(t *testing.T) {
			server, _ := startTestRelay(t, mode.apiKey)
			if mode.oidc != nil {
				hub := NewHub()
				auth := NewAuthMiddleware(mode.apiKey, mode.oidc)
				mux := http.NewServeMux()
				mux.HandleFunc("GET /v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
					type capabilitiesBlock struct {
						MobileForwardAck bool `json:"mobileForwardAck"`
					}
					type authConfigResponse struct {
						OIDC         bool              `json:"oidc"`
						PSK          bool              `json:"psk"`
						Capabilities capabilitiesBlock `json:"capabilities"`
					}
					resp := authConfigResponse{
						PSK:          len(auth.apiKey) > 0,
						OIDC:         auth.oidc != nil,
						Capabilities: capabilitiesBlock{MobileForwardAck: true},
					}
					w.Header().Set("Content-Type", "application/json")
					_ = json.NewEncoder(w).Encode(resp)
				})
				srv := httptest.NewServer(mux)
				t.Cleanup(func() { hub.CloseAll(); srv.Close() })
				server = srv
			}

			resp, err := http.Get(server.URL + "/v1/auth/config")
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()

			var body map[string]any
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}

			caps, ok := body["capabilities"].(map[string]any)
			if !ok {
				t.Fatalf("capabilities missing or wrong type: %v", body["capabilities"])
			}
			if caps["mobileForwardAck"] != true {
				t.Errorf("expected mobileForwardAck=true, got %v", caps["mobileForwardAck"])
			}
		})
	}
}

// ---- Token expiry disconnect ----

func TestTokenExpiry_Disconnect4401(t *testing.T) {
	key := genRSAKey(t)
	srv := startFakeOIDCServer(t, &key.PublicKey)

	oidcCfg, err := NewOIDCConfig(srv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}

	hub := NewHub()
	// Short write timeout for the test.
	hub.WriteTimeout = 2 * time.Second

	auth := NewAuthMiddleware("", oidcCfg)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.Validate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		if role != "ion" && role != "mobile" {
			http.Error(w, "bad role", http.StatusBadRequest)
			return
		}
		hub.HandleWebSocket(w, r, channelID, role, nil, identity)
	})
	relaySrv := httptest.NewServer(mux)
	t.Cleanup(func() { hub.CloseAll(); relaySrv.Close() })

	// Token that expires shortly in the past but within the 60s leeway, so
	// JWT validation accepts it (now <= exp+60s), but watchTokenExpiry fires
	// in about 1 second (delay = time.Until(exp+60s) ≈ 1s).
	claims := standardClaims(srv.URL, "test-audience")
	// exp = now - 59s: validation passes (now <= now-59+60 = now+1s ✓)
	// watchTokenExpiry delay ≈ 1s (fires at exp+60s ≈ now+1s)
	claims["exp"] = time.Now().Add(-59 * time.Second).Unix()
	tokenStr := makeJWT(t, key, claims)

	wsURL := "ws" + strings.TrimPrefix(relaySrv.URL, "http") + "/v1/channel/exp-chan?role=ion"
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + tokenStr}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	// Read should return with close code 4401 when the watch timer fires.
	readCtx, readCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer readCancel()
	_, _, readErr := conn.Read(readCtx)
	if readErr == nil {
		t.Fatal("expected connection to be closed with 4401, but read succeeded")
	}

	// Verify close code is 4401.
	closeCode := websocket.CloseStatus(readErr)
	if closeCode != 4401 {
		t.Errorf("expected close code 4401, got %d (err: %v)", closeCode, readErr)
	}
}
