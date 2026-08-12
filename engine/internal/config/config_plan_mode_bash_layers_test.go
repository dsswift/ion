package config

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the plan-mode Bash allowlist's layered semantics.
//
// Two independent mechanisms are pinned here:
//
//  1. MergeConfigs unions the user and project layers additively, so a repo can
//     declare the commands it needs without restating each developer's personal
//     list. This is a portability mechanism, NOT a security boundary.
//  2. EnforceEnterprise intersects that union against an enterprise ceiling, so
//     on a managed machine no engine.json at any lower layer can widen plan-mode
//     Bash past policy. This IS the security boundary.
//
// The pairing matters: (1) is deliberately permissive and only safe because (2)
// runs after it. Tests that pin one without the other would miss the point.

func limitsWithBash(cmds []string) *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Limits: types.LimitsConfig{PlanModeAllowedBashCommands: cmds},
	}
}

func bashList(cfg *types.EngineRuntimeConfig) []string {
	return cfg.Limits.PlanModeAllowedBashCommands
}

// --- Layer 1: additive union across user and project ---

// TestMergeConfigs_PlanModeBash_ProjectAddsToUser is the primary portability
// scenario: a developer's global config never mentions graphify, the project's
// .ion/engine.json declares it, and the resolved list contains both the
// developer's personal entries and the project's addition.
func TestMergeConfigs_PlanModeBash_ProjectAddsToUser(t *testing.T) {
	user := limitsWithBash([]string{"git log", "ls"})
	project := limitsWithBash([]string{"graphify"})

	merged := MergeConfigs(nil, user, project)
	got := bashList(merged)

	want := []string{"git log", "ls", "graphify"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected %v, got %v", want, got)
		}
	}
}

// TestMergeConfigs_PlanModeBash_UnionDropsDuplicates verifies overlapping
// entries collapse. Both layers legitimately name common commands, and the
// resolved list is echoed into the plan-mode system prompt, so repeats would
// be surfaced to the model.
func TestMergeConfigs_PlanModeBash_UnionDropsDuplicates(t *testing.T) {
	user := limitsWithBash([]string{"ls", "git log"})
	project := limitsWithBash([]string{"git log", "graphify", "ls"})

	got := bashList(MergeConfigs(nil, user, project))

	want := []string{"ls", "git log", "graphify"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

// TestMergeConfigs_PlanModeBash_NilProjectLeavesUser verifies a project that
// does not set the field at all leaves the user layer untouched. nil must stay
// distinguishable from [].
func TestMergeConfigs_PlanModeBash_NilProjectLeavesUser(t *testing.T) {
	user := limitsWithBash([]string{"git log", "graphify"})
	project := &types.EngineRuntimeConfig{} // field unset

	got := bashList(MergeConfigs(nil, user, project))
	if strings.Join(got, ",") != "git log,graphify" {
		t.Fatalf("nil project layer should leave user list intact, got %v", got)
	}
}

// TestMergeConfigs_PlanModeBash_EmptyProjectBlocksAll pins the block-all
// signal. An explicit [] from the higher-precedence layer means "no Bash in
// plan mode" and must beat the lower layer's non-empty list. Union semantics
// must not destroy this: [] is not "add nothing", it is "permit nothing".
func TestMergeConfigs_PlanModeBash_EmptyProjectBlocksAll(t *testing.T) {
	user := limitsWithBash([]string{"git log", "ls", "graphify"})
	project := limitsWithBash([]string{}) // explicit block-all

	got := bashList(MergeConfigs(nil, user, project))
	if got == nil {
		t.Fatal("expected non-nil empty slice (explicit block-all), got nil")
	}
	if len(got) != 0 {
		t.Fatalf("explicit empty project list must block all, got %v", got)
	}
}

// --- Layer 2: enterprise ceiling intersects the union ---

// TestEnforceEnterprise_PlanModeBash_NilCeilingLeavesUnion verifies the
// unmanaged-machine default. With no enterprise policy the merged union stands
// as-is: absent a policy there is nothing to circumvent, and this is what makes
// the project layer useful on a personal computer.
func TestEnforceEnterprise_PlanModeBash_NilCeilingLeavesUnion(t *testing.T) {
	merged := limitsWithBash([]string{"git log", "graphify"})
	enterprise := &types.EnterpriseConfig{} // no plan-mode policy

	got := bashList(EnforceEnterprise(merged, enterprise))
	if strings.Join(got, ",") != "git log,graphify" {
		t.Fatalf("nil ceiling must leave the union intact, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_StripsUnsanctioned is the core security
// property: a project committed into a repo cannot widen plan-mode Bash on a
// managed machine. "curl" and "sh" are not sanctioned and must be dropped.
func TestEnforceEnterprise_PlanModeBash_StripsUnsanctioned(t *testing.T) {
	merged := limitsWithBash([]string{"git log", "curl", "graphify", "sh"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git log", "graphify"}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	if strings.Join(got, ",") != "git log,graphify" {
		t.Fatalf("expected only sanctioned entries, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_ProjectCannotAddPastCeiling is your
// work-computer scenario stated directly: the project asks for graphify, the
// enterprise does not sanction it, and the project loses.
func TestEnforceEnterprise_PlanModeBash_ProjectCannotAddPastCeiling(t *testing.T) {
	user := limitsWithBash([]string{"git log"})
	project := limitsWithBash([]string{"graphify"})
	merged := MergeConfigs(nil, user, project)

	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git log", "ls"}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	for _, cmd := range got {
		if cmd == "graphify" {
			t.Fatal("project config circumvented the enterprise ceiling")
		}
	}
	if strings.Join(got, ",") != "git log" {
		t.Fatalf("expected [git log], got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_EmptyCeilingBlocksEverything verifies an
// explicit empty ceiling is a real policy ("no Bash in plan mode, ever") and
// strips every lower-layer entry, rather than being read as "no policy".
func TestEnforceEnterprise_PlanModeBash_EmptyCeilingBlocksEverything(t *testing.T) {
	merged := limitsWithBash([]string{"git log", "graphify"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	if len(got) != 0 {
		t.Fatalf("empty ceiling must strip everything, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_NarrowerEntryRetained verifies the
// permitted direction of prefix matching: ceiling "gh" sanctions "gh pr view",
// because the gate's prefix match already lets every "gh ..." command through
// when "gh" is allowed. Keeping the narrower entry grants nothing new.
func TestEnforceEnterprise_PlanModeBash_NarrowerEntryRetained(t *testing.T) {
	merged := limitsWithBash([]string{"gh pr view"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"gh"}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	if strings.Join(got, ",") != "gh pr view" {
		t.Fatalf("a narrower form of a ceiling entry must be retained, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_CannotGeneralizeCeilingEntry is the
// loophole test and the reason the prefix rule runs one way only. With ceiling
// "gh pr view", a project asking for bare "gh" must be DROPPED — retaining it
// would permit "gh repo delete", which the ceiling deliberately excluded.
//
// Invert the direction of the HasPrefix check in bashCommandWithinCeiling and
// this test goes red.
func TestEnforceEnterprise_PlanModeBash_CannotGeneralizeCeilingEntry(t *testing.T) {
	merged := limitsWithBash([]string{"gh"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"gh pr view"}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	if len(got) != 0 {
		t.Fatalf("a lower layer must not generalise a ceiling entry outward, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_WordBoundaryRequired verifies a prefix
// string coincidence does not pass as a policy match. Ceiling "git" must not
// sanction "github-cli-doer" just because the bytes line up; only genuine
// sub-commands separated by a space count as narrower forms.
func TestEnforceEnterprise_PlanModeBash_WordBoundaryRequired(t *testing.T) {
	merged := limitsWithBash([]string{"github-cli-doer", "git log"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git"}},
	}

	got := bashList(EnforceEnterprise(merged, enterprise))
	if strings.Join(got, ",") != "git log" {
		t.Fatalf("expected only the genuine sub-command, got %v", got)
	}
}

// TestEnforceEnterprise_PlanModeBash_RecordsEnforcement verifies stripped
// entries are observable. A silently-pruned entry would leave an operator
// unable to explain why their project config had no effect.
func TestEnforceEnterprise_PlanModeBash_RecordsEnforcement(t *testing.T) {
	DrainEnforcementActions() // clear any prior state

	merged := limitsWithBash([]string{"curl"})
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git log"}},
	}
	EnforceEnterprise(merged, enterprise)

	actions := DrainEnforcementActions()
	found := false
	for _, a := range actions {
		if a.Kind == EnforcementPlanModeBashPruned && a.Subject == "curl" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a plan_mode_bash_pruned action for curl, got %+v", actions)
	}
}

// TestEnforceEnterprise_PlanModeBash_DoesNotMutateInput mirrors the discipline
// the other seal tests enforce: enforcement returns a new config rather than
// editing the caller's slice in place.
func TestEnforceEnterprise_PlanModeBash_DoesNotMutateInput(t *testing.T) {
	original := []string{"git log", "curl"}
	merged := limitsWithBash(original)
	enterprise := &types.EnterpriseConfig{
		Limits: &types.EnterpriseLimits{PlanModeAllowedBashCommands: []string{"git log"}},
	}

	EnforceEnterprise(merged, enterprise)

	if strings.Join(original, ",") != "git log,curl" {
		t.Fatalf("EnforceEnterprise mutated the caller's slice: %v", original)
	}
}

func TestPlanModeMcpToolsEnterpriseCeilingRespectsBoundary(t *testing.T) {
	merged := []string{"mcp__mobbin__search_screens", "mcp__mobbin_internal__delete", "mcp__github__create_pr"}
	got := intersectMcpToolsWithCeiling(merged, []string{"mcp__mobbin"})
	if len(got) != 1 || got[0] != "mcp__mobbin__search_screens" {
		t.Fatalf("ceiling result = %v, want only Mobbin screen search", got)
	}
}
