package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/dsswift/ion/engine/internal/network"
)

const oidcClockSkew = 60 * time.Second

type oidcVerifier struct {
	issuerURL string
	clientID  string

	mu       sync.Mutex
	provider *oidc.Provider
	verifier *oidc.IDTokenVerifier
}

func newOIDCVerifier(issuerURL, clientID string) (*oidcVerifier, error) {
	if issuerURL == "" {
		return nil, fmt.Errorf("identity: issuerUrl is required for verified operator identity")
	}
	if clientID == "" {
		return nil, fmt.Errorf("identity: clientId is required for verified operator identity")
	}
	return &oidcVerifier{issuerURL: issuerURL, clientID: clientID}, nil
}

func (v *oidcVerifier) verify(ctx context.Context, rawIDToken, expectedNonce string) (*OperatorIdentity, error) {
	if rawIDToken == "" {
		return nil, fmt.Errorf("identity: missing id_token")
	}
	verifier, err := v.getVerifier(ctx)
	if err != nil {
		return nil, err
	}
	idToken, err := verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, fmt.Errorf("identity: verify id_token: %w", err)
	}
	if expectedNonce != "" && idToken.Nonce != expectedNonce {
		return nil, fmt.Errorf("identity: id_token nonce does not match login nonce")
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		return nil, fmt.Errorf("identity: decode verified id_token claims: %w", err)
	}
	claims, err = cloneClaims(claims)
	if err != nil {
		return nil, err
	}
	if err := validateOIDCClaimTimes(claims, time.Now()); err != nil {
		return nil, err
	}
	identity := operatorIdentityFromClaims(claims)
	identity.expiresAt = idToken.Expiry
	return identity, nil
}

func (v *oidcVerifier) getVerifier(ctx context.Context) (*oidc.IDTokenVerifier, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.verifier != nil {
		return v.verifier, nil
	}
	client := network.GetHTTPClient()
	providerCtx := oidc.ClientContext(ctx, client)
	provider, err := oidc.NewProvider(providerCtx, v.issuerURL)
	if err != nil {
		return nil, fmt.Errorf("identity: discover oidc provider: %w", err)
	}
	v.provider = provider
	v.verifier = provider.VerifierContext(providerCtx, &oidc.Config{
		ClientID: v.clientID,
		Now: func() time.Time {
			return time.Now().Add(oidcClockSkew)
		},
	})
	return v.verifier, nil
}

func validateOIDCClaimTimes(claims map[string]any, now time.Time) error {
	encoded, err := json.Marshal(claims)
	if err != nil {
		return fmt.Errorf("identity: marshal verified claims for time validation: %w", err)
	}
	var times struct {
		Expiry    int64 `json:"exp"`
		NotBefore int64 `json:"nbf"`
	}
	if err := json.Unmarshal(encoded, &times); err != nil {
		return fmt.Errorf("identity: decode verified claim times: %w", err)
	}
	if times.Expiry == 0 || now.After(time.Unix(times.Expiry, 0).Add(oidcClockSkew)) {
		return fmt.Errorf("identity: verified id_token is expired")
	}
	if times.NotBefore != 0 && now.Add(oidcClockSkew).Before(time.Unix(times.NotBefore, 0)) {
		return fmt.Errorf("identity: verified id_token is not active")
	}
	return nil
}

func operatorIdentityFromClaims(claims map[string]any) *OperatorIdentity {
	identity := &OperatorIdentity{Claims: claims}
	if username, ok := claims["preferred_username"].(string); ok {
		identity.Username = username
	}
	if name, ok := claims["name"].(string); ok {
		identity.Name = name
	}
	if oid, ok := claims["oid"].(string); ok && oid != "" {
		identity.Subject = oid
	} else if subject, ok := claims["sub"].(string); ok {
		identity.Subject = subject
	}
	return identity
}
