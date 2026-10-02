package config

import (
	"reflect"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// sealPermissions applies the enterprise permission policy over the merged
// config. The mode only moves toward stricter. Enterprise rules go ahead of
// the lower layers' rules, so they are evaluated first. Dangerous patterns
// and read-only paths are unioned. An enterprise tier rule replaces a lower
// layer's rule for the same tier.
func sealPermissions(result *types.EngineRuntimeConfig, enterprise *types.EnterpriseConfig) {
	policy := enterprise.Permissions
	if policy == nil {
		return
	}
	// With no permission block configured the engine runs in "allow" mode.
	sealed := types.PermissionPolicy{Mode: "allow"}
	if result.Permissions != nil {
		sealed = *result.Permissions
	}
	configuredMode := sealed.Mode
	sealed.Mode = stricterPermissionMode(sealed.Mode, policy.Mode)
	if len(policy.Rules) > 0 {
		// A lower-layer rule identical to an enterprise rule is already
		// covered, so sealing twice does not duplicate the enterprise rules.
		rules := make([]types.PermissionRule, 0, len(policy.Rules)+len(sealed.Rules))
		rules = append(rules, policy.Rules...)
		for _, rule := range sealed.Rules {
			if !containsRule(policy.Rules, rule) {
				rules = append(rules, rule)
			}
		}
		sealed.Rules = rules
	}
	sealed.DangerousPatterns = unionStrings(sealed.DangerousPatterns, policy.DangerousPatterns)
	sealed.ReadOnlyPaths = unionStrings(sealed.ReadOnlyPaths, policy.ReadOnlyPaths)
	if len(policy.TierRules) > 0 {
		tiers := make(map[string]string, len(sealed.TierRules)+len(policy.TierRules))
		for tier, decision := range sealed.TierRules {
			tiers[tier] = decision
		}
		for tier, decision := range policy.TierRules {
			tiers[tier] = decision
		}
		sealed.TierRules = tiers
	}
	result.Permissions = &sealed
	utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: permission policy applied", map[string]any{
		"configured_mode": configuredMode, "mode": sealed.Mode, "rule_count": len(policy.Rules),
	})
}

func containsRule(rules []types.PermissionRule, rule types.PermissionRule) bool {
	for _, candidate := range rules {
		if reflect.DeepEqual(candidate, rule) {
			return true
		}
	}
	return false
}

// permissionModeRank orders permission modes by strictness. An unknown mode
// ranks with "deny", which is how the permission engine treats it.
func permissionModeRank(mode string) int {
	switch mode {
	case "allow":
		return 0
	case "ask":
		return 1
	default:
		return 2
	}
}

// stricterPermissionMode returns whichever mode is stricter. An empty mode
// states no opinion.
func stricterPermissionMode(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	if permissionModeRank(b) > permissionModeRank(a) {
		return b
	}
	return a
}

// unionStrings returns base followed by the entries of add it does not
// already hold. base is returned as is when add is empty.
func unionStrings(base, add []string) []string {
	if len(add) == 0 {
		return base
	}
	seen := make(map[string]bool, len(base)+len(add))
	out := make([]string, 0, len(base)+len(add))
	for _, list := range [][]string{base, add} {
		for _, item := range list {
			if !seen[item] {
				seen[item] = true
				out = append(out, item)
			}
		}
	}
	return out
}
