package auth

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
)

// WorkloadSubject derives the stable principal subject for a verified workload
// identity. A provider that reports one (AWS returns the caller ARN) wins;
// otherwise the subject is built from the provider name and the client id the
// machine authenticates as, so two engines sharing one app registration are
// one principal and two registrations are two.
func WorkloadSubject(identity *ContextIdentity, provider string, cfg types.OAuthConfig) (string, error) {
	if identity != nil && identity.Subject != "" {
		return identity.Subject, nil
	}
	resolved, err := withResolvedClientID(provider, cfg)
	if err != nil {
		return "", err
	}
	if resolved.ClientID == "" {
		return "", fmt.Errorf("auth.oauth.%s has no client id to derive a workload subject from", provider)
	}
	return "workload:" + provider + ":" + resolved.ClientID, nil
}
