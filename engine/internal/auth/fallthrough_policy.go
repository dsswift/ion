// Package auth: the tenancy-derived credential fall-through policy (child 04).
//
// child 02 defined FallThroughPolicy as an interface and shipped
// allowAllFallThrough as the default (today's behavior: nothing refuses).
// This file supplies the real, config-derived policy: an attributed
// principal with no resolvable credential is refused by default on a
// partitioned instance, and fall-through is available only as an explicit
// opt-in (R-08).
package auth

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// RequiresPrincipalCredential reports whether this engine's tenancy
// configuration requires a resolvable per-principal credential -- i.e.
// whether an attributed principal with none should be refused rather than
// falling through to the process-wide resolver levels.
//
// cfg.Security.PrincipalPartitioning already carries the enterprise seal
// folded in by EnforceEnterprise/merge.go (RequirePrincipalPartitioning
// forces Enabled=true regardless of the user layer): there is no separate
// enterprise check to make here, because by the time this runs cfg is
// already the merged result. "Partitioning enabled with any enforcement
// above none" is the derived signal -- a partitioned instance keeping
// distinct storage per principal but permitting shared credentials would be
// a silent contradiction (SC-7).
func RequiresPrincipalCredential(cfg *types.EngineRuntimeConfig) bool {
	if cfg == nil || cfg.Security == nil {
		return false
	}
	return cfg.Security.PrincipalPartitioning.ResolvedEnforcement() != types.EnforcementNone
}

// derivedPolicy implements FallThroughPolicy from tenancy configuration
// (SC-7). required is RequiresPrincipalCredential's answer for this engine;
// allowFallThrough is the operator's explicit opt-in
// (PrincipalPartitioningConfig.AllowCredentialFallThrough).
type derivedPolicy struct {
	required         bool
	allowFallThrough bool
}

// NewTenancyFallThroughPolicy builds the real FallThroughPolicy for this
// engine's configuration, to be passed to auth.NewCredentialContext in
// place of the allow-all default child 02 shipped.
func NewTenancyFallThroughPolicy(cfg *types.EngineRuntimeConfig) FallThroughPolicy {
	required := RequiresPrincipalCredential(cfg)
	allow := false
	if cfg != nil && cfg.Security != nil && cfg.Security.PrincipalPartitioning != nil {
		allow = cfg.Security.PrincipalPartitioning.AllowCredentialFallThrough
	}
	return derivedPolicy{required: required, allowFallThrough: allow}
}

// AllowFallThrough decides whether subject may fall through to the
// resolver's process-wide levels when no registered PrincipalCredentialSource
// answered for it.
func (p derivedPolicy) AllowFallThrough(subject string) bool {
	if subject == "" {
		// Unattributed is never refused: an engine with no identity provider,
		// no server, and no principal must keep working unaided (R-25).
		utils.LogWithFields(utils.LevelDebug, "auth", "fall-through allowed", map[string]any{"reason": "unattributed"})
		return true
	}
	if !p.required {
		utils.LogWithFields(utils.LevelDebug, "auth", "fall-through allowed", map[string]any{"reason": "principal credential not required", "subject": subject})
		return true
	}
	if p.allowFallThrough {
		utils.LogWithFields(utils.LevelInfo, "auth", "fall-through allowed by opt-in", map[string]any{"subject": subject})
		return true
	}
	utils.LogWithFields(utils.LevelInfo, "auth", "fall-through refused", map[string]any{"subject": subject, "reason": "principal credential required"})
	return false
}
