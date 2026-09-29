package studioclient

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// TokenSource mints OIDC access tokens for the operator. `ion fleet` backs it
// with the local engine (`oidc_identity`, `oidc_token`), the same owner of the
// operator's grant the desktop asks.
type TokenSource interface {
	// Issuer is the issuer the operator is signed in to; empty when signed out.
	Issuer(ctx context.Context) (string, error)
	// Token mints an access token for scope (and audience, when set).
	Token(ctx context.Context, scope, audience string) (string, error)
}

// RelayIssuer is one issuer a relay accepts.
type RelayIssuer struct {
	Issuer        string `json:"issuer"`
	Audience      string `json:"audience"`
	RequiredScope string `json:"requiredScope"`
}

// RelayAuthConfig is a relay's `GET /v1/auth/config`.
type RelayAuthConfig struct {
	OIDC          bool          `json:"oidc"`
	PSK           bool          `json:"psk"`
	Issuer        string        `json:"issuer"`
	Audience      string        `json:"audience"`
	RequiredScope string        `json:"requiredScope"`
	Issuers       []RelayIssuer `json:"issuers,omitempty"`
}

// FetchRelayAuthConfig reads the relay's auth config over https.
func FetchRelayAuthConfig(ctx context.Context, relayURL string) (RelayAuthConfig, error) {
	var cfg RelayAuthConfig
	base := strings.TrimSuffix(relayURL, "/")
	base = strings.Replace(strings.Replace(base, "wss://", "https://", 1), "ws://", "http://", 1)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/v1/auth/config", nil)
	if err != nil {
		return cfg, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return cfg, fmt.Errorf("relay auth config: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if resp.StatusCode != http.StatusOK {
		return cfg, fmt.Errorf("relay auth config: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return cfg, err
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse relay auth config: %w", err)
	}
	return cfg, nil
}

// issuers is every issuer the relay accepts, primary first.
func (c RelayAuthConfig) issuers() []RelayIssuer {
	if len(c.Issuers) > 0 {
		return c.Issuers
	}
	if !c.OIDC || c.Issuer == "" {
		return nil
	}
	return []RelayIssuer{{Issuer: c.Issuer, Audience: c.Audience, RequiredScope: c.RequiredScope}}
}

// ChooseRelayIssuer picks the entry to present a token for: the only one when
// the relay accepts one, else the one matching the operator's issuer.
func ChooseRelayIssuer(c RelayAuthConfig, ownIssuer string) (RelayIssuer, bool) {
	accepted := c.issuers()
	if len(accepted) == 1 {
		return accepted[0], true
	}
	for _, i := range accepted {
		if ownIssuer != "" && i.Issuer == ownIssuer {
			return i, true
		}
	}
	return RelayIssuer{}, false
}

// ComposeOIDCScope builds the Entra-style scope `api://<audience>/<scope>`,
// or returns requiredScope as-is when it is already a full scope.
func ComposeOIDCScope(audience, requiredScope string) string {
	if strings.Contains(requiredScope, "/") || strings.HasPrefix(requiredScope, "api://") {
		return requiredScope
	}
	if strings.HasPrefix(audience, "api://") {
		return audience + "/" + requiredScope
	}
	return "api://" + audience + "/" + requiredScope
}

func sameIssuer(a, b string) bool {
	return strings.TrimSuffix(a, "/") == strings.TrimSuffix(b, "/")
}

// RelayBearer is the bearer a relay join presents for `relay`: its PSK, or an
// OIDC token minted for the operator. A relay-oidc relay binds its channels to
// the server's tenant, so an operator signed in elsewhere is refused before
// the join rather than claiming the channel.
func RelayBearer(ctx context.Context, relay Relay, tokens TokenSource) (string, error) {
	switch relay.Auth.Mode {
	case "psk":
		if relay.Auth.Key == "" {
			return "", fmt.Errorf("relay %s: the pairing stored no key", relay.URL)
		}
		return relay.Auth.Key, nil
	case "oidc":
		if tokens == nil {
			return "", fmt.Errorf("relay %s needs a signed-in operator", relay.URL)
		}
		return tokens.Token(ctx, relay.Auth.Scope, relay.Auth.Audience)
	case "relay-oidc":
		if tokens == nil {
			return "", fmt.Errorf("relay %s needs a signed-in operator", relay.URL)
		}
		own, err := tokens.Issuer(ctx)
		if err != nil {
			return "", err
		}
		if own == "" {
			return "", fmt.Errorf("relay %s needs a signed-in identity; sign in to Ion on this Mac", relay.URL)
		}
		if relay.Auth.Issuer != "" && !sameIssuer(relay.Auth.Issuer, own) {
			utils.LogWithFields(utils.LevelWarn, logTag, "relay join refused: operator signed in to a different tenant than the server", map[string]any{"relay_url": relay.URL, "server_issuer": relay.Auth.Issuer, "own_issuer": own})
			return "", fmt.Errorf("relay %s: the server joins it from %s and you are signed in to %s", relay.URL, relay.Auth.Issuer, own)
		}
		cfg, err := FetchRelayAuthConfig(ctx, relay.URL)
		if err != nil {
			return "", err
		}
		entry, ok := ChooseRelayIssuer(cfg, own)
		if !ok {
			return "", fmt.Errorf("relay %s accepts no issuer you are signed in to (%s)", relay.URL, own)
		}
		return tokens.Token(ctx, ComposeOIDCScope(entry.Audience, entry.RequiredScope), "")
	}
	return "", errors.New("relay " + relay.URL + ": unknown auth mode " + relay.Auth.Mode)
}
