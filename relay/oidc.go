package main

import (
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// UserIdentity represents an authenticated user from OIDC.
type UserIdentity struct {
	Subject  string
	Username string
	Roles    []string
	// TokenExpiry is the JWT expiry time; zero means no expiry (e.g. PSK).
	TokenExpiry time.Time
}

// OIDCConfig holds the OIDC configuration and JWKS state.
// A nil *OIDCConfig means OIDC is not enabled (PSK-only mode).
type OIDCConfig struct {
	Issuer        string
	Audience      string
	RequiredScope string

	mu             sync.RWMutex
	jwks           map[string]*rsa.PublicKey // kid -> RSA public key
	lastRefetch    time.Time                 // tracks rate-limiting for unknown-kid refetch
	lastSuccessful time.Time                 // time of last successful JWKS load
}

// NewOIDCConfig creates an OIDCConfig from environment variables.
// Returns nil, nil when issuer is empty (PSK-only mode).
// Returns nil plus an error when an issuer is set but the audience is empty:
// OIDC without a bound audience validates only the issuer, so a token minted
// for any other resource server on the same issuer would be accepted
// (audience-confusion bypass). That is a misconfiguration, not a degraded
// mode — fail loud and let the caller fall back to PSK-only rather than serve
// an OIDC mode that accepts every audience.
// On startup fetch failure, logs ERROR and returns the (partially-initialised) config
// plus the error; callers fall back to PSK-only.
func NewOIDCConfig(issuer, audience, requiredScope string) (*OIDCConfig, error) {
	if issuer == "" {
		return nil, nil
	}
	if audience == "" {
		return nil, fmt.Errorf("oidc issuer %q set without an audience: RELAY_OIDC_AUDIENCE is required for OIDC mode (an empty audience would accept tokens for any resource server on this issuer)", issuer)
	}

	cfg := &OIDCConfig{
		Issuer:        issuer,
		Audience:      audience,
		RequiredScope: requiredScope,
		jwks:          make(map[string]*rsa.PublicKey),
		lastRefetch:   time.Time{}, // zero so first unknown-kid triggers a fetch
	}

	if err := cfg.fetchJWKS(); err != nil {
		logger.Error("oidc: JWKS fetch failed at startup; serving PSK-only",
			"tag", "relay.oidc", "issuer", issuer, "err", err)
		return cfg, err
	}

	go cfg.backgroundRefresh()
	return cfg, nil
}

// backgroundRefresh fetches the JWKS once per day.
func (cfg *OIDCConfig) backgroundRefresh() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		if err := cfg.fetchJWKS(); err != nil {
			logger.Warn("oidc: background JWKS refresh failed; keeping last-known-good",
				"tag", "relay.oidc", "err", err)
		}
	}
}

// fetchJWKS discovers the jwks_uri via the OIDC discovery document, fetches the
// JWKS, and updates the cached key map. On failure the existing key map is
// preserved (last-known-good).
func (cfg *OIDCConfig) fetchJWKS() error {
	discoveryURL := strings.TrimSuffix(cfg.Issuer, "/") + "/.well-known/openid-configuration"
	resp, err := http.Get(discoveryURL) //nolint:noctx // startup fetch; no request context available
	if err != nil {
		return fmt.Errorf("discovery fetch: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close; error is irrelevant after decode
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("discovery endpoint returned %d", resp.StatusCode)
	}

	var discovery struct {
		JWKSURI string `json:"jwks_uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&discovery); err != nil {
		return fmt.Errorf("discovery decode: %w", err)
	}
	if discovery.JWKSURI == "" {
		return fmt.Errorf("jwks_uri not found in OIDC discovery document")
	}

	jwksResp, err := http.Get(discovery.JWKSURI) //nolint:noctx // startup fetch; no request context available
	if err != nil {
		return fmt.Errorf("jwks fetch: %w", err)
	}
	defer jwksResp.Body.Close() //nolint:errcheck // response body close; error is irrelevant after decode
	if jwksResp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks endpoint returned %d", jwksResp.StatusCode)
	}

	var jwkSet struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			Use string `json:"use"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(jwksResp.Body).Decode(&jwkSet); err != nil {
		return fmt.Errorf("jwks decode: %w", err)
	}

	newKeys := make(map[string]*rsa.PublicKey)
	for _, k := range jwkSet.Keys {
		if k.Kid == "" || k.Kty != "RSA" || k.N == "" || k.E == "" {
			continue
		}
		// Skip non-sig keys only when use is explicitly set to something else.
		if k.Use != "" && k.Use != "sig" {
			continue
		}
		pubKey, err := rsaPublicKeyFromJWK(k.N, k.E)
		if err != nil {
			logger.Warn("oidc: skipping unparseable RSA key",
				"tag", "relay.oidc", "kid", k.Kid, "err", err)
			continue
		}
		newKeys[k.Kid] = pubKey
	}

	if len(newKeys) == 0 {
		return fmt.Errorf("jwks contained no parseable RSA signing keys")
	}

	cfg.mu.Lock()
	cfg.jwks = newKeys
	cfg.lastSuccessful = time.Now()
	cfg.mu.Unlock()

	logger.Info("oidc: JWKS loaded",
		"tag", "relay.oidc", "issuer", cfg.Issuer, "key_count", len(newKeys))
	return nil
}

// refetchIfNeeded triggers a JWKS refetch when kid is unknown, rate-limited to
// once per 5 minutes.
func (cfg *OIDCConfig) refetchIfNeeded(kid string) {
	now := time.Now()
	cfg.mu.RLock()
	_, exists := cfg.jwks[kid]
	lastRefetch := cfg.lastRefetch
	cfg.mu.RUnlock()

	if exists {
		return
	}
	if now.Sub(lastRefetch) < 5*time.Minute {
		return
	}

	cfg.mu.Lock()
	cfg.lastRefetch = now
	cfg.mu.Unlock()

	if err := cfg.fetchJWKS(); err != nil {
		logger.Warn("oidc: on-demand JWKS refetch failed",
			"tag", "relay.oidc", "kid", kid, "err", err)
	}
}

// getKey looks up an RSA public key by kid, triggering a rate-limited refetch
// if the kid is unknown.
func (cfg *OIDCConfig) getKey(kid string) (*rsa.PublicKey, bool) {
	cfg.refetchIfNeeded(kid)
	cfg.mu.RLock()
	defer cfg.mu.RUnlock()
	k, ok := cfg.jwks[kid]
	return k, ok
}

// rsaPublicKeyFromJWK decodes base64url-encoded n and e JWK components into
// an *rsa.PublicKey.
func rsaPublicKeyFromJWK(nStr, eStr string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(nStr)
	if err != nil {
		return nil, fmt.Errorf("decode n: %w", err)
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(eStr)
	if err != nil {
		return nil, fmt.Errorf("decode e: %w", err)
	}

	e := 0
	for _, b := range eBytes {
		e = (e << 8) | int(b)
	}
	if e == 0 {
		return nil, fmt.Errorf("invalid exponent (zero)")
	}

	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: e,
	}, nil
}

// ValidateJWT parses and validates a JWT bearer token. Returns the caller's
// UserIdentity on success, or an error describing why validation failed.
// The 60-second leeway applies to exp and nbf.
func (cfg *OIDCConfig) ValidateJWT(tokenStr string) (*UserIdentity, error) {
	if cfg == nil {
		return nil, fmt.Errorf("oidc not configured")
	}

	parser := jwt.NewParser(
		jwt.WithLeeway(60*time.Second),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
	)

	claims := jwt.MapClaims{}
	token, err := parser.ParseWithClaims(tokenStr, claims, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		kid, ok := token.Header["kid"].(string)
		if !ok || kid == "" {
			return nil, fmt.Errorf("missing kid in token header")
		}
		pubKey, ok := cfg.getKey(kid)
		if !ok {
			return nil, fmt.Errorf("key %q not found in JWKS", kid)
		}
		return pubKey, nil
	})
	if err != nil {
		return nil, fmt.Errorf("jwt parse: %w", err)
	}
	if !token.Valid {
		return nil, fmt.Errorf("token is not valid")
	}

	// Validate issuer.
	iss, err := claims.GetIssuer()
	if err != nil || iss != cfg.Issuer {
		return nil, fmt.Errorf("issuer mismatch: got %q, want %q", iss, cfg.Issuer)
	}

	// Validate audience.
	if cfg.Audience != "" {
		aud, err := claims.GetAudience()
		if err != nil {
			return nil, fmt.Errorf("audience claim: %w", err)
		}
		found := false
		for _, a := range aud {
			if a == cfg.Audience {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("audience mismatch: %v does not include %q", aud, cfg.Audience)
		}
	}

	// Validate required scope — handles both "scp" (Entra v1) and "scope" (Entra v2).
	if cfg.RequiredScope != "" {
		scopeStr := ""
		if v, ok := claims["scp"].(string); ok {
			scopeStr = v
		} else if v, ok := claims["scope"].(string); ok {
			scopeStr = v
		}
		if scopeStr == "" {
			return nil, fmt.Errorf("required scope %q missing: no scp/scope claim", cfg.RequiredScope)
		}
		found := false
		for _, s := range strings.Fields(scopeStr) {
			if s == cfg.RequiredScope {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("required scope %q not in %q", cfg.RequiredScope, scopeStr)
		}
	}

	// Extract identity.
	identity := &UserIdentity{}

	// Subject: prefer "oid", fall back to "sub".
	if oid, ok := claims["oid"].(string); ok && oid != "" {
		identity.Subject = oid
	} else {
		sub, err := claims.GetSubject()
		if err != nil || sub == "" {
			return nil, fmt.Errorf("no subject claim (oid or sub)")
		}
		identity.Subject = sub
	}

	if prefUser, ok := claims["preferred_username"].(string); ok {
		identity.Username = prefUser
	}

	if rolesVal, ok := claims["roles"].([]interface{}); ok {
		for _, r := range rolesVal {
			if rStr, ok := r.(string); ok {
				identity.Roles = append(identity.Roles, rStr)
			}
		}
	}

	// Capture token expiry for connection expiry enforcement.
	if exp, err := claims.GetExpirationTime(); err == nil && exp != nil {
		identity.TokenExpiry = exp.Time
	}

	return identity, nil
}

// isJWTShaped reports whether the bearer token value looks like a JWT
// (three base64url segments separated by dots). Used to route to JWT vs PSK.
func isJWTShaped(bearerToken string) bool {
	parts := strings.Split(bearerToken, ".")
	return len(parts) == 3 && parts[0] != "" && parts[1] != "" && parts[2] != ""
}
