package main

import (
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// configureIdentityReadiness installs the configured identity and proves a
// workload identity before the server can bind its socket.
func configureIdentityReadiness(cfg *types.AuthConfig) (*auth.IdentityManager, *auth.WorkloadVerification, error) {
	if cfg == nil {
		return nil, nil, nil
	}
	manager, err := auth.ConfigureIdentityProviders(cfg)
	if err != nil {
		return nil, nil, err
	}
	if !configuredMachineIdentity(cfg) {
		return manager, nil, nil
	}
	verification, err := auth.VerifyConfiguredWorkloadAtStartup(cfg)
	if err != nil {
		return nil, nil, err
	}
	return manager, verification, nil
}

func configuredMachineIdentity(cfg *types.AuthConfig) bool {
	if cfg == nil || cfg.IdentityProvider == "" {
		return false
	}
	oauthCfg, ok := cfg.OAuth[cfg.IdentityProvider]
	return ok && oauthCfg.MachineIdentity != nil
}

func identityReadinessStage(cfg *types.AuthConfig) string {
	if configuredMachineIdentity(cfg) {
		return "verify"
	}
	return "configure"
}
