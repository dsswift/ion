package fleet

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/engineipc"
)

// EngineTokens mints relay OIDC tokens from this Mac's engine, which owns the
// operator's sign-in: `oidc_identity` for the issuer, `oidc_token` for a token.
// The refresh token never leaves the engine.
type EngineTokens struct {
	Network string
	Socket  string
}

const engineTokenTimeout = 35 * time.Second

// Issuer implements studioclient.TokenSource.
func (e EngineTokens) Issuer(ctx context.Context) (string, error) {
	res, err := engineipc.Request(e.Network, e.Socket, map[string]any{"cmd": "oidc_identity"}, engineTokenTimeout)
	if err != nil {
		return "", fmt.Errorf("ask this Mac's engine who is signed in: %w", err)
	}
	var id struct {
		SignedIn bool   `json:"signedIn"`
		Issuer   string `json:"issuer"`
	}
	if err := engineipc.Data(res, &id); err != nil {
		return "", fmt.Errorf("oidc_identity: %w", err)
	}
	if !id.SignedIn {
		return "", nil
	}
	return id.Issuer, nil
}

// Token implements studioclient.TokenSource.
func (e EngineTokens) Token(ctx context.Context, scope, audience string) (string, error) {
	msg := map[string]any{"cmd": "oidc_token", "oidcScope": scope}
	if audience != "" {
		msg["oidcAudience"] = audience
	}
	res, err := engineipc.Request(e.Network, e.Socket, msg, engineTokenTimeout)
	if err != nil {
		return "", fmt.Errorf("ask this Mac's engine for a relay token: %w", err)
	}
	var tok struct {
		AccessToken string `json:"accessToken"`
	}
	if err := engineipc.Data(res, &tok); err != nil {
		return "", fmt.Errorf("oidc_token: %w", err)
	}
	if tok.AccessToken == "" {
		return "", fmt.Errorf("oidc_token returned no token")
	}
	return tok.AccessToken, nil
}
