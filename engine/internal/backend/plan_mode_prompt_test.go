package backend

import (
	"strings"
	"testing"
)

// Tests for buildPlanModePrompt and buildPlanModeSparseReminder text content.
// These pin the exact disambiguation strings that prevent the agent from
// confusing a newly-allocated plan slug with historical slugs from prior
// planning cycles in the same conversation.

const testPlanPath = "/home/user/.ion/plans/rapid-prancing-berry.md"

// TestBuildPlanModePrompt_NewFile_DisambiguationNote verifies that the prompt
// for a brand-new plan file (planFileExists=false) contains the cycle-
// disambiguation note. Without this note the agent can be confused by sparse-
// reminder injections from prior planning cycles that cite different paths.
func TestBuildPlanModePrompt_NewFile_DisambiguationNote(t *testing.T) {
	out := buildPlanModePrompt(testPlanPath, false, nil, nil)
	wantPhrases := []string{
		"CURRENT planning cycle",
		"completed cycles and are no longer active",
		"do not write to them",
	}
	for _, phrase := range wantPhrases {
		if !strings.Contains(out, phrase) {
			t.Errorf("new-file prompt missing expected disambiguation phrase %q", phrase)
		}
	}
	// The plan path must still appear.
	if !strings.Contains(out, testPlanPath) {
		t.Errorf("new-file prompt does not contain plan path %q", testPlanPath)
	}
}

// TestBuildPlanModePrompt_ExistingFile_NoDisambiguationNote verifies that the
// existing-file branch does NOT inject the new-file disambiguation note —
// the note is only needed when the assigned file is new (not yet on disk).
func TestBuildPlanModePrompt_ExistingFile_NoDisambiguationNote(t *testing.T) {
	out := buildPlanModePrompt(testPlanPath, true, nil, nil)
	if strings.Contains(out, "CURRENT planning cycle") {
		t.Error("existing-file prompt should not contain the new-cycle disambiguation note")
	}
	// The plan path and the amend section must still appear.
	if !strings.Contains(out, testPlanPath) {
		t.Errorf("existing-file prompt does not contain plan path %q", testPlanPath)
	}
	if !strings.Contains(out, "Amending an Existing Plan") {
		t.Error("existing-file prompt missing amend section")
	}
}

// TestBuildPlanModePrompt_RestrictionBullet verifies the rewritten restriction
// bullet explicitly mentions the previous-cycle case so the agent can't read
// the restriction as applying only to invented names.
func TestBuildPlanModePrompt_RestrictionBullet(t *testing.T) {
	for _, exists := range []bool{false, true} {
		out := buildPlanModePrompt(testPlanPath, exists, nil, nil)
		wantPhrases := []string{
			"ONLY valid plan file for this session",
			"previous cycle",
		}
		for _, phrase := range wantPhrases {
			if !strings.Contains(out, phrase) {
				t.Errorf("prompt (exists=%v) missing restriction phrase %q", exists, phrase)
			}
		}
	}
}

// TestBuildPlanModePrompt_BashSection_Unchanged verifies that the bash section
// and read-only tool list are unaffected by the disambiguation changes.
func TestBuildPlanModePrompt_BashSection_Unchanged(t *testing.T) {
	// Without bash allowlist: MUST NOT call Bash restriction present.
	out := buildPlanModePrompt(testPlanPath, false, nil, nil)
	if !strings.Contains(out, "MUST NOT call Bash") {
		t.Error("no-bash-allowlist prompt missing 'MUST NOT call Bash'")
	}

	// With bash allowlist: Bash (restricted) added, prefix listed.
	outBash := buildPlanModePrompt(testPlanPath, false, []string{"gh", "go test"}, nil)
	if !strings.Contains(outBash, "Bash (restricted)") {
		t.Error("bash-allowlist prompt missing 'Bash (restricted)'")
	}
	if !strings.Contains(outBash, "gh, go test") {
		t.Error("bash-allowlist prompt missing allowed prefixes")
	}
}

// TestBuildPlanModeSparseReminder_CycleNote verifies that every sparse reminder
// injection carries the cycle-disambiguation clause. Each reminder is verbatim
// in the conversation context, so all of them must be unambiguous.
func TestBuildPlanModeSparseReminder_CycleNote(t *testing.T) {
	out := buildPlanModeSparseReminder(testPlanPath)
	wantPhrases := []string{
		"only valid plan file for this session",
		"prior completed cycles",
		testPlanPath,
	}
	for _, phrase := range wantPhrases {
		if !strings.Contains(out, phrase) {
			t.Errorf("sparse reminder missing expected phrase %q", phrase)
		}
	}
}

// TestBuildPlanModePrompt_ThirdPath_DirectAnswer verifies that the Turn
// Behavior section documents the third legal turn-ending: an informational or
// read-only request that needs no plan is answered directly, and that answer
// legally ends the turn. Without this clause the model reads the turn contract
// as binary (AskUserQuestion OR ExitPlanMode) and manufactures a needless
// question when a request carries no plan to present.
func TestBuildPlanModePrompt_ThirdPath_DirectAnswer(t *testing.T) {
	for _, exists := range []bool{false, true} {
		out := buildPlanModePrompt(testPlanPath, exists, nil, nil)
		wantPhrases := []string{
			"one of three ways",
			"A direct answer",
			"answered directly in visible assistant text",
			"do NOT call ExitPlanMode when there is no plan to present",
		}
		for _, phrase := range wantPhrases {
			if !strings.Contains(out, phrase) {
				t.Errorf("prompt (exists=%v) missing third-path phrase %q", exists, phrase)
			}
		}
	}
}

// TestBuildPlanModePrompt_NoBinaryPhrasing verifies the superseded binary
// framing ("one of two ways" / "Do not end a turn without one of these") is
// gone. That phrasing presented AskUserQuestion and ExitPlanMode as the only
// legal endings, which is the exact coercion the third path removes.
func TestBuildPlanModePrompt_NoBinaryPhrasing(t *testing.T) {
	for _, exists := range []bool{false, true} {
		out := buildPlanModePrompt(testPlanPath, exists, nil, nil)
		badPhrases := []string{
			"one of two ways",
			"Do not end a turn without one of these",
		}
		for _, phrase := range badPhrases {
			if strings.Contains(out, phrase) {
				t.Errorf("prompt (exists=%v) still contains superseded binary phrasing %q", exists, phrase)
			}
		}
	}
}

// TestBuildPlanModeSparseReminder_ThirdPath verifies the per-turn sparse
// reminder carries the same third-path clause, so the re-injected reminder
// stops re-asserting the binary contract every few turns.
func TestBuildPlanModeSparseReminder_ThirdPath(t *testing.T) {
	out := buildPlanModeSparseReminder(testPlanPath)
	wantPhrases := []string{
		"one of three ways",
		"answered directly in visible assistant text",
		"do not call ExitPlanMode when there is no plan to present",
	}
	for _, phrase := range wantPhrases {
		if !strings.Contains(out, phrase) {
			t.Errorf("sparse reminder missing third-path phrase %q", phrase)
		}
	}
	// The superseded binary clause must be gone.
	if strings.Contains(out, "End turns with AskUserQuestion (for clarifications) or ExitPlanMode") {
		t.Error("sparse reminder still contains superseded binary end-turn clause")
	}
}

// TestBuildPlanModePrompt_AdvertisesSkill verifies the plan-mode system prompt
// names Skill in its read-only tool list. The prose is derived from
// defaultPlanModeTools, so this also pins that the advertised set and the
// enforced set cannot drift apart.
func TestBuildPlanModePrompt_AdvertisesSkill(t *testing.T) {
	out := buildPlanModePrompt(testPlanPath, false, nil, nil)
	if !strings.Contains(out, "Skill") {
		t.Error("plan-mode prompt does not advertise the Skill tool")
	}
}

// TestBuildPlanModePrompt_ToolProseMatchesAllowlist verifies every tool in
// defaultPlanModeTools appears in the prompt prose. A hand-maintained prose
// list previously drifted from the enforced allowlist; deriving it from the
// slice makes that impossible, and this test pins the guarantee.
func TestBuildPlanModePrompt_ToolProseMatchesAllowlist(t *testing.T) {
	out := buildPlanModePrompt(testPlanPath, false, nil, nil)
	for _, tool := range defaultPlanModeTools {
		if !strings.Contains(out, tool) {
			t.Errorf("plan-mode prompt prose omits allowlisted tool %q", tool)
		}
	}
}

func TestBuildPlanModePromptNamesAllowedMcpTools(t *testing.T) {
	out := buildPlanModePrompt(testPlanPath, false, nil, []string{"mcp__mobbin__search_screens"})
	if !strings.Contains(out, "mcp__mobbin__search_screens") {
		t.Fatalf("plan prompt does not name MCP allowlist: %s", out)
	}
}
