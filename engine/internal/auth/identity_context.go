package auth

import (
	"encoding/json"
	"fmt"
)

const maxContextIdentityClaimBytes = 256 * 1024

// ContextIdentity is credential-free verified identity state for an extension
// invocation. Claims contain JSON-compatible values from a verified ID token.
type ContextIdentity struct {
	Kind        string         `json:"kind"`
	Provider    string         `json:"provider"`
	Subject     string         `json:"subject,omitempty"`
	Username    string         `json:"username,omitempty"`
	DisplayName string         `json:"displayName,omitempty"`
	Attribution string         `json:"attribution,omitempty"`
	Source      string         `json:"source,omitempty"`
	Claims      map[string]any `json:"claims,omitempty"`
}

// ContextIdentityProvider optionally exposes verified identity state without
// exposing bearer credentials.
type ContextIdentityProvider interface {
	ContextIdentity() *ContextIdentity
}

// cloneContextIdentity returns an independent copy safe for another caller.
func cloneContextIdentity(identity *ContextIdentity) *ContextIdentity {
	if identity == nil {
		return nil
	}
	clone := *identity
	if identity.Claims != nil {
		claims, err := cloneClaims(identity.Claims)
		if err != nil {
			return nil
		}
		clone.Claims = claims
	}
	return &clone
}

func cloneClaims(claims map[string]any) (map[string]any, error) {
	if claims == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(claims)
	if err != nil {
		return nil, fmt.Errorf("marshal claims: %w", err)
	}
	if len(encoded) > maxContextIdentityClaimBytes {
		return nil, fmt.Errorf("claims exceed %d byte limit: %d", maxContextIdentityClaimBytes, len(encoded))
	}
	var copied map[string]any
	if err := json.Unmarshal(encoded, &copied); err != nil {
		return nil, fmt.Errorf("copy claims: %w", err)
	}
	return copied, nil
}

// ContextIdentityChange describes a complete verified identity snapshot.
type ContextIdentityChange struct {
	Identity *ContextIdentity
	Reason   string
}
