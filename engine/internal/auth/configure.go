package auth

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ConfigureIdentityProviders builds and installs the selected provider. Invalid
// machine config fails loudly but callers may keep the daemon running without a
// credential provider so unrelated sessions remain available.
func ConfigureIdentityProviders(cfg *types.AuthConfig) (*IdentityManager, error) {
	SetTokenProvider(nil)
	SetAWSCredentialsProvider(nil)
	SetContextIdentityProvider(nil)
	if cfg == nil || cfg.IdentityProvider == "" {
		if cfg != nil && cfg.RequireOperatorIdentity {
			return nil, fmt.Errorf("auth.requireOperatorIdentity requires auth.identityProvider")
		}
		utils.LogWithFields(utils.LevelInfo, "auth.identity", "no identity provider configured", nil)
		return nil, nil
	}
	oauthCfg, ok := cfg.OAuth[cfg.IdentityProvider]
	if !ok {
		return nil, fmt.Errorf("auth.identityProvider %q names a missing auth.oauth entry", cfg.IdentityProvider)
	}
	if cfg.RequireOperatorIdentity && oauthCfg.MachineIdentity != nil {
		return nil, fmt.Errorf("auth.requireOperatorIdentity requires an interactive operator provider; auth.identityProvider %q uses machineIdentity", cfg.IdentityProvider)
	}
	if oauthCfg.MachineIdentity == nil {
		// A verified operator identity is proven by checking the id_token
		// signature, which needs the provider's JWKS. JWKS is reached through
		// OIDC discovery from issuerUrl. An operator provider without issuerUrl
		// can still mint access tokens (explicit tokenUrl), but every identity
		// verification — interactive login, startup reconcile, background
		// renewal — fails with "issuerUrl is required", and the failure only
		// surfaces later in renewal retries. Warn loudly at boot instead.
		if oauthCfg.IssuerURL == "" {
			utils.LogWithFields(utils.LevelWarn, "auth.identity", "operator identity provider has no issuerUrl; identity verification cannot run", map[string]any{
				"provider":      cfg.IdentityProvider,
				"has_token_url": oauthCfg.TokenURL != "",
				"remedy":        "set auth.oauth." + cfg.IdentityProvider + ".issuerUrl so OIDC discovery can reach the provider's signing keys",
			})
		}
		operator := NewIdentityManager(cfg.IdentityProvider, oauthCfg, cfg.RefreshThresholdMs)
		SetTokenProvider(operator)
		SetContextIdentityProvider(operator)
		utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator identity provider configured", map[string]any{
			"provider": cfg.IdentityProvider, "signed_in": operator.SignedIn(),
		})
		return operator, nil
	}
	machine, err := NewMachineIdentityManager(cfg.IdentityProvider, oauthCfg, cfg.RefreshThresholdMs)
	if err != nil {
		return nil, err
	}
	if machine.AWSProvider() != nil {
		SetAWSCredentialsProvider(machine.AWSProvider())
	} else {
		SetTokenProvider(machine)
	}
	SetContextIdentityProvider(machine)
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "machine identity provider configured", map[string]any{
		"provider": cfg.IdentityProvider, "source": machine.SourceKind(),
	})
	// Machine identity has no interactive manager by design. Generic bearer/AWS
	// registries serve headless consumers; OIDC login/logout remain operator-only.
	return nil, nil
}
