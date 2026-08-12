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
	if cfg == nil || cfg.IdentityProvider == "" {
		utils.LogWithFields(utils.LevelInfo, "auth.identity", "no identity provider configured", nil)
		return nil, nil
	}
	oauthCfg, ok := cfg.OAuth[cfg.IdentityProvider]
	if !ok {
		return nil, fmt.Errorf("auth.identityProvider %q names a missing auth.oauth entry", cfg.IdentityProvider)
	}
	if oauthCfg.MachineIdentity == nil {
		operator := NewIdentityManager(cfg.IdentityProvider, oauthCfg, cfg.RefreshThresholdMs)
		SetTokenProvider(operator)
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
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "machine identity provider configured", map[string]any{
		"provider": cfg.IdentityProvider, "source": machine.SourceKind(),
	})
	// Machine identity has no interactive manager by design. Generic bearer/AWS
	// registries serve headless consumers; OIDC login/logout remain operator-only.
	return nil, nil
}
