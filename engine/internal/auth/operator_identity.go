package auth

import "time"

// OperatorIdentity carries the identity claims of the signed-in operator,
// extracted from the OIDC id_token.
type OperatorIdentity struct {
	// Subject is the stable subject identifier (Entra: the oid claim,
	// falling back to sub).
	Subject string `json:"subject"`
	// Username is the human-readable identity used for attribution
	// (Entra: preferred_username -- UPN/email for work accounts).
	Username string `json:"username"`
	// Name is the display name claim when present.
	Name string `json:"name,omitempty"`
	// Provider is the auth-config key this identity was minted under
	// (e.g. "entra").
	Provider string `json:"provider"`
	// Claims preserves every JSON-compatible claim from the verified id_token.
	Claims    map[string]any `json:"claims,omitempty"`
	expiresAt time.Time
	// Attribution is the value of the configured attributionClaim, when
	// set. Takes precedence over the standard fallback chain in
	// AttributionValue.
	Attribution string `json:"attribution,omitempty"`
}

// Issuer returns the verified id_token's iss claim: which issuer signed this
// identity. A consumer offered several accepted issuers by a resource
// server uses it to pick its own. Read from the persisted claims, so an
// identity restored from disk reports it without a new sign-in.
func (id *OperatorIdentity) Issuer() string {
	if id == nil {
		return ""
	}
	iss, _ := id.Claims["iss"].(string) //nolint:errcheck // absent or non-string claim reads as no issuer
	return iss
}

// AttributionValue returns the identity string stamped on telemetry and
// egress records: the configured attributionClaim's value when set, else
// preferred_username, else the subject.
func (id *OperatorIdentity) AttributionValue() string {
	if id == nil {
		return ""
	}
	if id.Attribution != "" {
		return id.Attribution
	}
	if id.Username != "" {
		return id.Username
	}
	return id.Subject
}
