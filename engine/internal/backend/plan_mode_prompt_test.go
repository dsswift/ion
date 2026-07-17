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
	out := buildPlanModePrompt(testPlanPath, false, nil)
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
	out := buildPlanModePrompt(testPlanPath, true, nil)
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
		out := buildPlanModePrompt(testPlanPath, exists, nil)
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
	out := buildPlanModePrompt(testPlanPath, false, nil)
	if !strings.Contains(out, "MUST NOT call Bash") {
		t.Error("no-bash-allowlist prompt missing 'MUST NOT call Bash'")
	}

	// With bash allowlist: Bash (restricted) added, prefix listed.
	outBash := buildPlanModePrompt(testPlanPath, false, []string{"gh", "go test"})
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
