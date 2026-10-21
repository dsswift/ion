// run_as_principal.go — who a headless session acts as.
//
// A headless session (headless_session.go) is minted by the engine for an
// engine-scoped host's fire, with nobody at the controls. It still needs a
// SessionPrincipal: storage partition, per-principal tool policy, telemetry
// attribution, and git author all key on it. The extensionHosts.runAs block
// says where that principal comes from; this file resolves it once at boot.
package session

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const runAsLogTag = "session.engine_hosts"

// resolveRunAsPrincipal turns the configured run-as block into the principal
// every headless session carries. Nil config yields nil: headless sessions
// run unattributed, and that choice is logged so it is never a surprise.
func resolveRunAsPrincipal(ctx context.Context, runAs *types.RunAsPrincipalConfig, authCfg *types.AuthConfig) (*types.SessionPrincipal, error) {
	if runAs == nil {
		utils.LogWithFields(utils.LevelWarn, runAsLogTag, "run-as principal unset; headless sessions are unattributed", nil)
		return nil, nil
	}
	if err := runAs.Validate(); err != nil {
		return nil, err
	}
	switch runAs.Mode {
	case types.RunAsModePrincipal:
		p := *runAs.Principal
		if p.Kind == "" {
			p.Kind = "operator"
		}
		utils.LogWithFields(utils.LevelInfo, runAsLogTag, "run-as principal resolved", map[string]any{"mode": runAs.Mode, "principal_subject": p.Subject, "provider": p.Provider, "kind": p.Kind})
		return &p, nil
	case types.RunAsModeWorkload:
		return resolveWorkloadPrincipal(ctx, authCfg)
	default:
		return nil, fmt.Errorf("extensionHosts.runAs.mode %q is not supported", runAs.Mode)
	}
}

// resolveWorkloadPrincipal proves the engine's own machine identity and
// projects it to a principal of kind "workload".
func resolveWorkloadPrincipal(ctx context.Context, authCfg *types.AuthConfig) (*types.SessionPrincipal, error) {
	if authCfg == nil || authCfg.IdentityProvider == "" {
		return nil, fmt.Errorf("extensionHosts.runAs.mode workload needs auth.identityProvider to name an oauth entry with machineIdentity")
	}
	oauthCfg, ok := authCfg.OAuth[authCfg.IdentityProvider]
	if !ok || oauthCfg.MachineIdentity == nil {
		return nil, fmt.Errorf("extensionHosts.runAs.mode workload: auth.oauth.%s is not a machineIdentity entry", authCfg.IdentityProvider)
	}
	verification, err := auth.VerifyConfiguredWorkload(ctx, authCfg)
	if err != nil {
		utils.LogWithFields(utils.LevelError, runAsLogTag, "workload identity verification failed", map[string]any{"provider": authCfg.IdentityProvider, "error": err.Error()})
		return nil, fmt.Errorf("verify workload identity %q: %w", authCfg.IdentityProvider, err)
	}
	if verification == nil || verification.Identity == nil {
		return nil, fmt.Errorf("verify workload identity %q: no identity returned", authCfg.IdentityProvider)
	}
	subject, err := auth.WorkloadSubject(verification.Identity, authCfg.IdentityProvider, oauthCfg)
	if err != nil {
		return nil, err
	}
	p := &types.SessionPrincipal{
		Subject:     subject,
		Provider:    verification.Identity.Provider,
		Kind:        "workload",
		Username:    authCfg.IdentityProvider,
		DisplayName: verification.Identity.DisplayName,
	}
	if p.Provider == "" {
		p.Provider = authCfg.IdentityProvider
	}
	utils.LogWithFields(utils.LevelInfo, runAsLogTag, "run-as principal resolved", map[string]any{"mode": types.RunAsModeWorkload, "principal_subject": p.Subject, "provider": p.Provider, "kind": p.Kind, "expires_at": verification.ExpiresAt})
	return p, nil
}
