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
	// authFailureIssuerNotTrusted is returned for a server-announced-trust
	// join (manifest C7) whose announced issuer is not in the operator's
	// RELAY_TRUSTED_ISSUERS allowlist.
	authFailureIssuerNotTrusted AuthFailureReason = "issuer_not_trusted"
	// authFailureSubjectNotAnnounced is returned when a channel's
	// announcement names the one subject allowed to join and a valid token
	// for the announced issuer proves a different one.
	authFailureSubjectNotAnnounced AuthFailureReason = "subject_not_announced"
	// authFailureJWKSUnavailable is returned when a trusted issuer's JWKS
	// could not be fetched. The ion peer that announced trust is
	// unaffected; only this one join attempt fails.
	authFailureJWKSUnavailable AuthFailureReason = "jwks_unavailable"
	// authFailurePairingExpired is returned for a pairing channel (manifest
	// C7) join attempted after its 5-minute expiry or after its single
	// permitted use.
	authFailurePairingExpired AuthFailureReason = "pairing_expired"
)

// AuthMiddleware validates requests via PSK and/or OIDC JWT.
// When both are configured, a JWT-shaped bearer token is tried against OIDC
// first; a non-JWT bearer is tried against PSK. The two modes are independent
// and can be active simultaneously.
type AuthMiddleware struct {
	apiKey []byte      // PSK (may be nil when OIDC-only)
	oidc   *OIDCConfig // primary OIDC issuer (may be nil when PSK-only)
	// issuers is every accepted org-wide issuer, primary first. A JWT is
	// routed to the entry matching its iss claim.
	issuers []*OIDCConfig
}

// NewAuthMiddleware creates an AuthMiddleware.
// apiKey may be empty when oidc is non-nil. oidc may be nil when apiKey is set.
// more lists further accepted issuers (RELAY_OIDC_ISSUERS); oidc stays the
// primary one.
func NewAuthMiddleware(apiKey string, oidc *OIDCConfig, more ...*OIDCConfig) *AuthMiddleware {
	var issuers []*OIDCConfig
	if oidc != nil {
		issuers = append(issuers, oidc)
	}
	for _, cfg := range more {
		if cfg != nil {
			issuers = append(issuers, cfg)
		}
	}
	return &AuthMiddleware{
		apiKey:  []byte(apiKey),
		oidc:    oidc,
		issuers: issuers,
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
	bearer, reason := extractBearerToken(r)
	if reason != "" {
		return nil, reason
	}

	// JWT path: OIDC configured and token looks like a JWT.
	//
	// Routing is by token shape, not auth mode: a JWT-shaped bearer that fails
	// OIDC validation returns here and does NOT fall through to the PSK compare.
	// A PSK containing two dots would therefore be unauthenticatable in dual
	// mode. The documented PSK generator (`openssl rand -hex 32`) emits a
	// dot-free hex string, so real-world PSKs never collide with the JWT shape.
	if len(a.issuers) > 0 && isJWTShaped(bearer) {
		identity, err := validateAgainstIssuers(a.issuers, bearer)
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

// extractBearerToken pulls the bearer token out of an Authorization header,
// or returns a safe failure reason when the header is missing, malformed,
// or uses a scheme other than Bearer. Shared by ValidateDetailed (the
// baseline org-wide auth path) and the server-announced-trust path
// (announce.go), which both need the raw token string before deciding
// which validator to run it through.
func extractBearerToken(r *http.Request) (string, AuthFailureReason) {
	header := r.Header.Get("Authorization")
	if header == "" {
		return "", authFailureMissingAuthorization
	}

	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || parts[1] == "" {
		return "", authFailureMalformedAuthorization
	}
	if !strings.EqualFold(parts[0], "Bearer") {
		return "", authFailureInvalidScheme
	}

	return parts[1], ""
}
