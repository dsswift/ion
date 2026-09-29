package main

// oidc_issuers.go — several org-wide OIDC issuers on one relay.
//
// RELAY_OIDC_ISSUER/AUDIENCE/REQUIRED_SCOPE name one issuer. A relay whose
// operator signs in from more than one identity tenant needs each of them
// accepted for the ion role, with that tenant's own audience and scope:
// a token is minted by the tenant the person is signed in to, for the
// resource registration that exists in that tenant. RELAY_OIDC_ISSUERS
// carries the additional ones.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
)

// OIDCIssuerSpec is one accepted issuer with the audience and scope a token
// from it must carry. It is both the RELAY_OIDC_ISSUERS entry shape and the
// GET /v1/auth/config `issuers[]` entry shape.
type OIDCIssuerSpec struct {
	Issuer        string `json:"issuer"`
	Audience      string `json:"audience"`
	RequiredScope string `json:"requiredScope,omitempty"`
}

// parseOIDCIssuerSpecs resolves the ordered issuer list from the single-issuer
// variables and the RELAY_OIDC_ISSUERS JSON array. The single-issuer entry,
// when set, is first; the first entry overall is the primary issuer, the one
// GET /v1/auth/config reports in its top-level issuer/audience/requiredScope
// fields. An entry with no issuer or no audience is an error rather than a
// skipped entry: an audience-less issuer would accept a token minted for any
// resource on that issuer.
func parseOIDCIssuerSpecs(issuer, audience, requiredScope, listJSON string) ([]OIDCIssuerSpec, error) {
	var specs []OIDCIssuerSpec
	if issuer != "" {
		specs = append(specs, OIDCIssuerSpec{Issuer: issuer, Audience: audience, RequiredScope: requiredScope})
	}
	if strings.TrimSpace(listJSON) != "" {
		var listed []OIDCIssuerSpec
		if err := json.Unmarshal([]byte(listJSON), &listed); err != nil {
			return nil, fmt.Errorf("RELAY_OIDC_ISSUERS is not a JSON array of {issuer,audience,requiredScope}: %w", err)
		}
		specs = append(specs, listed...)
	}
	seen := make(map[string]bool)
	for i, s := range specs {
		if s.Issuer == "" {
			return nil, fmt.Errorf("oidc issuer entry %d has no issuer", i)
		}
		if s.Audience == "" {
			return nil, fmt.Errorf("oidc issuer %q set without an audience (an empty audience would accept tokens for any resource server on this issuer)", s.Issuer)
		}
		key := s.Issuer + "\x00" + s.Audience
		if seen[key] {
			return nil, fmt.Errorf("oidc issuer %q with audience %q is listed twice", s.Issuer, s.Audience)
		}
		seen[key] = true
	}
	return specs, nil
}

// unverifiedIssuer reads the iss claim from a JWT without verifying it. It
// only chooses WHICH configured issuer validates the token; that issuer's
// own JWKS then verifies the signature and re-checks iss, so a forged iss
// selects a validator that refuses it.
func unverifiedIssuer(token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", false
	}
	var claims struct {
		Iss string `json:"iss"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Iss == "" {
		return "", false
	}
	return claims.Iss, true
}

// validateAgainstIssuers validates token against the configured issuer whose
// Issuer equals the token's iss claim. Two entries may share an issuer with
// different audiences; each is tried. The returned identity's OwnerKey is
// the bare subject for the primary issuer (so channel bindings persisted
// before there were several issuers still match) and issuer-qualified for
// every other one, because two issuers may hand out the same subject string.
func validateAgainstIssuers(issuers []*OIDCConfig, token string) (*UserIdentity, error) {
	iss, ok := unverifiedIssuer(token)
	if !ok {
		return nil, fmt.Errorf("token carries no readable iss claim")
	}
	var lastErr error
	for i, cfg := range issuers {
		if cfg.Issuer != iss {
			continue
		}
		identity, err := cfg.ValidateJWT(token)
		if err != nil {
			lastErr = err
			continue
		}
		if i == 0 {
			identity.OwnerKey = identity.Subject
		} else {
			identity.OwnerKey = cfg.Issuer + "|" + identity.Subject
		}
		return identity, nil
	}
	if lastErr != nil {
		return nil, lastErr
	}
	return nil, fmt.Errorf("issuer %q is not configured on this relay", iss)
}
