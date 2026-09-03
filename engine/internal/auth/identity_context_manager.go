package auth

import (
	"encoding/json"
	"time"
)

// ContextIdentity returns a defensive, credential-free projection of the
// cached verified identity.
func (m *IdentityManager) ContextIdentity() *ContextIdentity {
	identity := m.Identity()
	if identity == nil {
		return nil
	}
	return &ContextIdentity{Kind: "operator", Provider: identity.Provider, Subject: identity.Subject,
		Username: identity.Username, DisplayName: identity.Name, Attribution: identity.Attribution,
		Claims: cloneClaimsOrNil(identity.Claims)}
}

func (m *IdentityManager) cacheIdentity(identity *OperatorIdentity) {
	m.mu.Lock()
	m.identity = cloneOperatorIdentity(identity)
	m.identityExpiry = identityExpiry(identity)
	m.identityResolved = true
	m.mu.Unlock()
}

func (m *IdentityManager) publishIdentity(identity *OperatorIdentity, reason string) {
	var contextIdentity *ContextIdentity
	if identity != nil {
		contextIdentity = &ContextIdentity{Kind: "operator", Provider: identity.Provider, Subject: identity.Subject,
			Username: identity.Username, DisplayName: identity.Name, Attribution: identity.Attribution,
			Claims: cloneClaimsOrNil(identity.Claims)}
	}
	publishContextIdentityChange(ContextIdentityChange{Identity: contextIdentity, Reason: reason})
}

func cloneClaimsOrNil(claims map[string]any) map[string]any {
	copy, err := cloneClaims(claims)
	if err != nil {
		return nil
	}
	return copy
}

func identityExpiry(identity *OperatorIdentity) time.Time {
	if identity == nil {
		return time.Time{}
	}
	return identity.expiresAt
}

func cloneOperatorIdentity(identity *OperatorIdentity) *OperatorIdentity {
	if identity == nil {
		return nil
	}
	copy := *identity
	copy.Claims = cloneClaimsOrNil(identity.Claims)
	return &copy
}

func operatorIdentityEqual(left, right *OperatorIdentity) bool {
	leftJSON, leftErr := json.Marshal(left)
	rightJSON, rightErr := json.Marshal(right)
	return leftErr == nil && rightErr == nil && string(leftJSON) == string(rightJSON)
}
