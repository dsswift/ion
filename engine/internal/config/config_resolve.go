package config

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolvePlanModeBashAllowlist reads the plan-mode Bash allowlist FRESH from
// engine.json at call time, running the full layered merge (defaults < global
// < project) and enterprise enforcement, but with NO process-global side
// effects (no log-level change, no ConfigureLogging, no provider-backend
// validation). It is safe to call on every prompt dispatch.
//
// The allowlist is engine policy — the engine decides which Bash commands the
// model may run during plan mode. Resolving it fresh here (rather than reading
// the boot-cached m.config) means an operator can edit
// ~/.ion/engine.json's `limits.planModeAllowedBashCommands` mid-conversation
// and the next prompt honors it, with no daemon restart. A headless consumer
// with no client gets its allowlist from its own config the same way.
//
// Return contract (tri-valued, mirroring the set_plan_mode wire field):
//
//   - (value, true)  — a config layer set the field. value is used verbatim,
//     INCLUDING an explicit empty slice, which means "block Bash entirely in
//     plan mode". The caller must not fall back on found=true+empty.
//   - (nil, false)   — no layer set the field. The caller decides the fallback
//     (today: the boot-cached m.config value, else block Bash).
//
// The nil-vs-non-nil distinction is preserved end to end: the JSON decoder
// allocates a non-nil empty slice for `[]`, distinct from the nil a wholly
// absent field produces, and mergeInto only overrides dst when the source
// slice is non-nil (see merge.go).
//
// projectDir is the run's working directory; passing "" resolves global-only
// (the headless default when no project is in scope).
func ResolvePlanModeBashAllowlist(projectDir string) ([]string, bool) {
	merged := mergeConfigLayers(projectDir)
	cmds := merged.Limits.PlanModeAllowedBashCommands
	found := cmds != nil
	utils.LogWithFields(utils.LevelDebug, "config", "resolved plan-mode bash allowlist fresh", map[string]any{
		"project_dir": projectDir,
		"found":       found,
		"count":       len(cmds),
		"allowlist":   cmds,
	})
	return cmds, found
}

// ClampPlanModeBashToEnterprise filters a run-time plan-mode Bash allowlist
// down to what enterprise policy sanctions, returning the input unchanged when
// no enterprise ceiling is configured.
//
// Why this exists separately from the EnforceEnterprise path: the engine.json
// layer is clamped during the config merge, but the plan-mode allowlist has two
// additional run-time sources that never pass through a config merge at all —
// the session-scoped `set_plan_mode` wire command and the per-prompt
// `bashAllowlistAdditionsForThisPrompt` additions. A ceiling that bound only
// engine.json would leave both open, which is the reverse of useful: those two
// are client-supplied and therefore the easier paths to abuse, while
// engine.json is the one an operator controls directly.
//
// Call this at the point where the effective run-time list is assembled so all
// three sources are clamped by one gate. Every dropped entry is recorded as an
// enforcement action.
func ClampPlanModeBashToEnterprise(cmds []string) []string {
	if len(cmds) == 0 {
		return cmds
	}
	enterprise := LoadEnterpriseConfig()
	if enterprise == nil || enterprise.Limits == nil || enterprise.Limits.PlanModeAllowedBashCommands == nil {
		// No policy on this axis: the caller's list stands.
		return cmds
	}
	return intersectBashCommandsWithCeiling(cmds, enterprise.Limits.PlanModeAllowedBashCommands)
}
