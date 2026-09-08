package tools

import (
	"strings"
	"testing"
)

// EnterPlanModeTool ships only the engine's policy-neutral one-line
// fallback description. The longer prose with WHEN/WHAT/WHEN-NOT
// guidance lives in the harness (ADR-004) and reaches the LLM via
// EnterPlanModeToolWithDescription(opts.EnterPlanModeDescription) on
// each run.
//
// This test pins three properties of the engine side of the contract:
//  1. The no-arg default is short and contains no harness policy.
//  2. The forbidden harness-specific phrases that used to live in the
//     engine (commits 89084038 / 7e61687b) are not present.
//  3. The WithDescription constructor forwards the harness string
//     verbatim and falls back to the engine default on empty input.
func TestEnterPlanModeDefaultDescriptionIsNeutral(t *testing.T) {
	td := EnterPlanModeTool()
	desc := td.Description

	if desc != enterPlanModeDefaultDescription {
		t.Errorf("EnterPlanModeTool default description drifted from constant: got %q want %q", desc, enterPlanModeDefaultDescription)
	}

	// Sanity: the default must be a single short sentence. Anything
	// longer than ~120 chars suggests policy prose has crept back in.
	if len(desc) > 120 {
		t.Errorf("EnterPlanMode default description is suspiciously long (%d chars); policy prose belongs in the harness per ADR-004: %q", len(desc), desc)
	}

	// The default must NOT carry harness-specific framing that used to
	// live in the engine. If any of these phrases come back, ADR-004
	// has regressed and engine policy is bleeding into LLM-visible text.
	forbidden := []string{
		"Implement the following plan",
		"You are implementing a user-approved plan",
		"already in plan mode",
		"simple enough to execute directly",
		"implement an existing plan",
		"multiple files",
		"architectural changes",
		"non-trivial scope",
	}
	for _, f := range forbidden {
		if strings.Contains(desc, f) {
			t.Errorf("EnterPlanMode default description must NOT contain harness-policy phrase %q (ADR-004: prose lives in the harness)", f)
		}
	}
}

// EnterPlanModeToolWithDescription forwards the supplied prose verbatim
// when non-empty and falls back to the engine default otherwise.
func TestEnterPlanModeWithDescription(t *testing.T) {
	// Empty input → engine default.
	td := EnterPlanModeToolWithDescription("")
	if td.Description != enterPlanModeDefaultDescription {
		t.Errorf("empty desc input should fall back to engine default; got %q", td.Description)
	}

	// Non-empty input → forwarded verbatim. Use a string the engine
	// would never write on its own (multi-paragraph, contains domain
	// language) so a future "engine wraps harness prose" bug surfaces
	// clearly.
	harnessProse := `Switch into plan mode for a test plan.

Conditions:
- Multi-step validation required
- Cross-system integration risk

Do NOT enter if the user has already approved a test plan and is in the execution phase.`
	td = EnterPlanModeToolWithDescription(harnessProse)
	if td.Description != harnessProse {
		t.Errorf("non-empty desc input should be forwarded verbatim; got %q want %q", td.Description, harnessProse)
	}

	// Whitespace-only input is treated as a real string (not empty);
	// the engine doesn't decide what counts as "empty for prose
	// purposes" — that's a harness decision. If a harness sends "   "
	// they get "   " as the description and presumably their LLM is
	// not going to like it. Pin the behavior so a well-intentioned
	// future contributor doesn't add string-trimming logic that
	// silently drops harness intent.
	td = EnterPlanModeToolWithDescription("   ")
	if td.Description != "   " {
		t.Errorf("whitespace-only desc must be forwarded verbatim (not trimmed to default); got %q", td.Description)
	}

	// Structural fields are unchanged across the two constructors.
	defaultTD := EnterPlanModeTool()
	customTD := EnterPlanModeToolWithDescription("anything")
	if defaultTD.Name != customTD.Name {
		t.Errorf("Name must match across constructors: default=%q custom=%q", defaultTD.Name, customTD.Name)
	}
	if defaultTD.Name != EnterPlanModeName {
		t.Errorf("Name must be EnterPlanModeName constant: got %q want %q", defaultTD.Name, EnterPlanModeName)
	}
}
