package main

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// AuthFailureReason classifies an authentication failure for operator logs.
// Values are deliberately generic. They never contain credentials, claims, or
// validation errors that could expose authentication data.
type AuthFailureReason string

const (
	authFailureMissingAuthorization   AuthFailureReason = "missing_authorization"
	authFailureMalformedAuthorization AuthFailureReason = "malformed_authorization"
	authFailureInvalidScheme          AuthFailureReason = "invalid_authorization_scheme"
	authFailureJWTValidation          AuthFailureReason = "jwt_validation_failed"
	authFailurePSKMismatch            AuthFailureReason = "psk_mismatch"
)

// AuthMiddleware validates requests via PSK and/or OIDC JWT.
// When both are configured, a JWT-shaped bearer token is tried against OIDC
// first; a non-JWT bearer is tried against PSK. The two modes are independent
// and can be active simultaneously.
type AuthMiddleware struct {
	apiKey []byte      // PSK (may be nil when OIDC-only)
	oidc   *OIDCConfig // OIDC config (may be nil when PSK-only)
}

// NewAuthMiddleware creates an AuthMiddleware.
// apiKey may be empty when oidc is non-nil. oidc may be nil when apiKey is set.
func NewAuthMiddleware(apiKey string, oidc *OIDCConfig) *AuthMiddleware {
	return &AuthMiddleware{
		apiKey: []byte(apiKey),
		oidc:   oidc,
	}
}

// Validate checks the Authorization: Bearer header and returns the
// authenticated UserIdentity and whether authentication succeeded.
//
//   - JWT-shaped bearer + OIDC configured → JWT validation; returns (identity, true) on success.
//   - Non-JWT bearer + PSK configured → constant-time PSK compare; returns (nil, true) on match.
//   - Both can be active at the same time.
//   - Returns (nil, false) when auth fails or no credential is provided.
//
// Validate remains the compatibility wrapper for callers that do not need the
// safe failure classification exposed by ValidateDetailed.
func (a *AuthMiddleware) Validate(r *http.Request) (*UserIdentity, bool) {
	identity, reason := a.ValidateDetailed(r)
	return identity, reason == ""
}

// ValidateDetailed authenticates a request and returns a safe failure reason.
// A blank reason means authentication succeeded. The reason is suitable for
// structured logs, but must never be replaced with a token, claim, or raw
// validation error.
func (a *AuthMiddleware) ValidateDetailed(r *http.Request) (*UserIdentity, AuthFailureReason) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return nil, authFailureMissingAuthorization
	}

	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || parts[1] == "" {
		return nil, authFailureMalformedAuthorization
	}
	if !strings.EqualFold(parts[0], "Bearer") {
		return nil, authFailureInvalidScheme
	}

	bearer := parts[1]

	// JWT path: OIDC configured and token looks like a JWT.
	//
	// Routing is by token shape, not auth mode: a JWT-shaped bearer that fails
	// OIDC validation returns here and does NOT fall through to the PSK compare.
	// A PSK containing two dots would therefore be unauthenticatable in dual
	// mode. The documented PSK generator (`openssl rand -hex 32`) emits a
	// dot-free hex string, so real-world PSKs never collide with the JWT shape.
	if a.oidc != nil && isJWTShaped(bearer) {
		identity, err := a.oidc.ValidateJWT(bearer)
		if err != nil {
			return nil, authFailureJWTValidation
		}
		return identity, ""
	}

	// PSK path: constant-time compare.
	if len(a.apiKey) > 0 && subtle.ConstantTimeCompare([]byte(bearer), a.apiKey) == 1 {
		return nil, ""
	}

	return nil, authFailurePSKMismatch
}
