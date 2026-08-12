package config

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// merge_ceilings.go — the enterprise sealed-ceiling clamps.
//
// EnforceEnterprise (merge.go) decides WHICH axes a policy seals; these helpers
// implement HOW each seal narrows a merged user+project value. They are pure
// functions over the merged value and the enterprise ceiling, extracted from
// merge.go as one cohesive cluster: every function here answers "what survives
// the ceiling", and each records an enforcement action for the entries policy
// rejected so the operator can see what was pruned and why.

// intersectBashCommandsWithCeiling clamps a merged plan-mode Bash allowlist to
// an enterprise ceiling, returning only the entries the ceiling sanctions.
//
// An empty (non-nil) ceiling is the "no Bash in plan mode" policy and strips
// everything. Otherwise an entry is retained when it is exactly a ceiling
// entry, or when it is a MORE SPECIFIC form of one — ceiling "gh" retains
// "gh pr view", because the gate's prefix matching already lets every "gh ..."
// command through when "gh" is permitted, so keeping the narrower entry grants
// nothing new.
//
// The asymmetry is the whole security property, and it runs one way only:
// a lower layer can never generalise a ceiling entry outward. With ceiling
// "gh pr view", a project asking for "gh" is dropped, not kept — retaining it
// would permit "gh repo delete", which the ceiling deliberately excluded.
// Every dropped entry is recorded as an enforcement action so the operator can
// see which project/user entries policy rejected.
func intersectBashCommandsWithCeiling(merged, ceiling []string) []string {
	if len(ceiling) == 0 {
		// Explicit block-all policy. Record each stripped entry.
		for _, cmd := range merged {
			recordEnforcement(EnforcementPlanModeBashPruned, cmd, "planModeAllowedBashCommands", map[string]any{
				"reason": "enterprise policy blocks Bash in plan mode",
			})
		}
		return []string{}
	}
	out := make([]string, 0, len(merged))
	for _, cmd := range merged {
		if bashCommandWithinCeiling(cmd, ceiling) {
			out = append(out, cmd)
			continue
		}
		recordEnforcement(EnforcementPlanModeBashPruned, cmd, "planModeAllowedBashCommands", map[string]any{
			"reason": "not permitted by enterprise plan-mode Bash ceiling",
		})
	}
	return out
}

// bashCommandWithinCeiling reports whether cmd is permitted by the ceiling:
// an exact match, or an extension of a ceiling entry at a word boundary.
//
// The word-boundary check prevents a prefix-string coincidence from passing as
// a policy match: ceiling "git" must not sanction "github-cli-doer" merely
// because the bytes line up. Requiring the next character to be a space means
// only genuine sub-commands ("git log") are treated as narrower forms.
func bashCommandWithinCeiling(cmd string, ceiling []string) bool {
	for _, allowed := range ceiling {
		if cmd == allowed {
			return true
		}
		if strings.HasPrefix(cmd, allowed+" ") {
			return true
		}
	}
	return false
}

func intersectMcpToolsWithCeiling(merged, ceiling []string) []string {
	if len(ceiling) == 0 {
		for _, tool := range merged {
			recordEnforcement(EnforcementPlanModeMcpPruned, tool, "planModeAllowedMcpTools", map[string]any{"reason": "enterprise policy blocks MCP tools in plan mode"})
		}
		return []string{}
	}
	out := make([]string, 0, len(merged))
	for _, tool := range merged {
		if entryWithinCeiling(tool, ceiling, "__") {
			out = append(out, tool)
			continue
		}
		recordEnforcement(EnforcementPlanModeMcpPruned, tool, "planModeAllowedMcpTools", map[string]any{"reason": "not permitted by enterprise plan-mode MCP ceiling"})
	}
	return out
}

func entryWithinCeiling(entry string, ceiling []string, separator string) bool {
	for _, allowed := range ceiling {
		if entry == allowed || strings.HasPrefix(entry, allowed+separator) {
			return true
		}
	}
	return false
}

// sealLimitCeiling resolves one resource-limit field against the enterprise
// ceiling. A nil enterprise value leaves the user value untouched (no policy
// on this axis). A non-nil enterprise value caps the result: an absent or
// higher user value is replaced by the ceiling; a lower user value stands
// (users may self-restrict below policy, never exceed it).
func sealLimitCeiling(user, enterprise *int, name string) *int {
	if enterprise == nil {
		return user
	}
	if user == nil || *user > *enterprise {
		if user != nil {
			utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: resource limit capped to ceiling", map[string]any{"limit": name, "user": *user, "ceiling": *enterprise})
		}
		v := *enterprise
		return &v
	}
	return user
}
