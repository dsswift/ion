package telemetry

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// currentTokenProvider indirects auth.CurrentTokenProvider so a test can
// substitute a provider without standing up a real identity.
var currentTokenProvider = func() auth.TokenProvider { return auth.CurrentTokenProvider() }

// telemetry_eventhub_credential.go resolves how the "eventhub" target
// authenticates, and deliberately puts the secretless path first.
//
// A connection string is a shared secret. Shipping one to a fleet means the
// same key sits on every managed device: any holder can write to the hub,
// revoking one device means rotating the key for all of them, and every
// sender is indistinguishable at the transport. Token authentication ships
// nothing secret — the engine's existing identity (a signed-in user, or a
// machine identity on a headless install) mints a short-lived token, and
// authorization is an RBAC assignment revocable per principal.
//
// The connection string remains supported because it is the only thing the
// local emulator understands, and because a container deployment may
// legitimately prefer mounting a secret it already manages.

// EventHubConnectionStringEnv overrides any configured connection string.
//
// Env-var precedence exists for the container case: an operator mounting a
// secret into a container should not have to bake it into an image or a
// config file that ends up in an image layer. An explicitly-set environment
// variable is the operator's most direct statement of intent, so it wins.
const EventHubConnectionStringEnv = "ION_EVENTHUB_CONNECTION_STRING"

// DefaultEventHubTokenScope is the resource scope for Azure Event Hubs.
// Event Hubs rejects a token audienced to anything else, which is why this
// cannot reuse whatever scope an operator already uses for their own API.
const DefaultEventHubTokenScope = "https://eventhubs.azure.net/.default"

// unknownTokenLifetime is the expiry reported for a provider that cannot say
// when its token expires. Short enough that a stale token is re-minted
// promptly, long enough that the mint is not per-send.
const unknownTokenLifetime = 5 * time.Minute

// engineTokenCredential adapts the engine's identity provider to the Azure
// SDK's TokenCredential, so the Event Hub client authenticates as the same
// principal everything else in the engine does rather than carrying its own
// credential configuration.
type engineTokenCredential struct {
	scope    string
	audience string
}

// GetToken implements azcore.TokenCredential.
//
// The SDK passes the scopes it wants, but the engine's provider is
// configured with the scope the operator granted, and a provider that
// silently substituted the caller's would mint tokens for a resource the
// operator never approved. So the configured scope wins and a mismatch is
// logged rather than quietly honored.
func (c *engineTokenCredential) GetToken(ctx context.Context, opts policy.TokenRequestOptions) (azcore.AccessToken, error) {
	provider := currentTokenProvider()
	if provider == nil {
		return azcore.AccessToken{}, fmt.Errorf("event hub token credential: no identity provider configured (set auth.identityProvider)")
	}
	if len(opts.Scopes) > 0 && opts.Scopes[0] != c.scope {
		utils.LogWithFields(utils.LevelDebug, "telemetry", "event hub sdk requested a different scope than configured; using the configured one", map[string]any{
			"requested": opts.Scopes[0], "configured": c.scope,
		})
	}
	// Expiry-aware providers let the SDK schedule its own refresh. For one
	// that is not, a conservative near-term expiry is reported instead of a
	// zero time: the SDK treats a zero ExpiresOn as already-expired and
	// would mint on every single send.
	if expiring, ok := provider.(auth.ExpiringTokenProvider); ok {
		token, expiresAt, err := expiring.GetTokenWithAudienceExpiry(ctx, c.scope, c.audience)
		if err != nil {
			return azcore.AccessToken{}, fmt.Errorf("event hub token mint: %w", err)
		}
		return azcore.AccessToken{Token: token, ExpiresOn: expiresAt}, nil
	}
	token, err := provider.GetTokenWithAudience(ctx, c.scope, c.audience)
	if err != nil {
		return azcore.AccessToken{}, fmt.Errorf("event hub token mint: %w", err)
	}
	return azcore.AccessToken{Token: token, ExpiresOn: time.Now().Add(unknownTokenLifetime)}, nil
}

// eventHubCredentialMode names the resolved authentication path, for logs
// and for tests that assert precedence without reaching a broker.
type eventHubCredentialMode string

const (
	credentialModeEnvConnectionString    eventHubCredentialMode = "env_connection_string"
	credentialModeToken                  eventHubCredentialMode = "token"
	credentialModeConfigConnectionString eventHubCredentialMode = "config_connection_string"
	credentialModeNone                   eventHubCredentialMode = "none"
)

// resolveEventHubCredentialMode picks the authentication path for a config.
//
// Precedence, and why:
//  1. The environment connection string — the operator's most explicit
//     statement, and the container secret-mounting path.
//  2. A configured namespace — secretless, so it is preferred over a secret
//     the operator also happens to have configured.
//  3. A configured connection string — supported, including for the local
//     emulator, which speaks nothing else.
func resolveEventHubCredentialMode(config types.TelemetryConfig) (eventHubCredentialMode, string) {
	if envConn := os.Getenv(EventHubConnectionStringEnv); envConn != "" {
		return credentialModeEnvConnectionString, envConn
	}
	if config.EventHubNamespace != "" {
		return credentialModeToken, config.EventHubNamespace
	}
	if config.EventHubConnectionString != "" {
		return credentialModeConfigConnectionString, config.EventHubConnectionString
	}
	return credentialModeNone, ""
}

// eventHubTokenScope resolves the scope to request, defaulting to the Event
// Hubs resource.
func eventHubTokenScope(config types.TelemetryConfig) string {
	if config.EventHubTokenScope != "" {
		return config.EventHubTokenScope
	}
	return DefaultEventHubTokenScope
}

// tokenRequestScopes builds the SDK's request options for a scope list. A
// thin helper so callers and tests do not each import the policy package
// just to construct a one-field struct.
func tokenRequestScopes(scopes ...string) policy.TokenRequestOptions {
	return policy.TokenRequestOptions{Scopes: scopes}
}
