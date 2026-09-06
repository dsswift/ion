package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the WritePlan/EditPlan pair that lets a delegated claude-code
// plan-mode run author its plan file, and for the ExitPlanMode contract change
// that stops requiring the plan markdown as an argument.

// The whole point of the pair is that the model cannot name a file. A path
// parameter would reintroduce exactly the traversal/redirect surface that
// stripping Write was meant to close, so its absence is the security property
// and is pinned here rather than left to review.
func TestPlanFileToolsExposeNoPathParameter(t *testing.T) {
	for _, tc := range []struct {
		name   string
		schema map[string]any
		want   []string
	}{
		{"WritePlan", schemaOf(CliWritePlanTool), []string{"content"}},
		{"EditPlan", schemaOf(CliEditPlanTool), []string{"old_string", "new_string"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			props, ok := tc.schema["properties"].(map[string]any)
			if !ok {
				t.Fatalf("%s schema has no properties map", tc.name)
			}
			if len(props) != len(tc.want) {
				t.Errorf("%s properties = %v, want exactly %v", tc.name, keysOf(props), tc.want)
			}
			for _, want := range tc.want {
				if _, ok := props[want]; !ok {
					t.Errorf("%s missing required property %q", tc.name, want)
				}
			}
			// Any property that could name a file is a defect.
			for _, banned := range []string{"path", "file_path", "filePath", "file", "target"} {
				if _, ok := props[banned]; ok {
					t.Errorf("%s exposes %q — the plan path must be resolved by the engine, never supplied by the model", tc.name, banned)
				}
			}
		})
	}
}

// ExitPlanMode must accept a bare call. This is the regression that reverting
// `required: []string{}` back to `{"plan"}` would trip: with `plan` required,
// the model re-emits the entire plan it already wrote to the file.
func TestCliExitPlanModeDoesNotRequirePlanArgument(t *testing.T) {
	_, desc, schema := CliExitPlanModeTool()

	required, ok := schema["required"].([]string)
	if !ok {
		t.Fatalf("ExitPlanMode schema `required` is not []string: %T", schema["required"])
	}
	if len(required) != 0 {
		t.Errorf("ExitPlanMode required = %v, want empty — the plan lives in the plan file", required)
	}

	// The fallback argument must survive: a model that never wrote the file
	// still needs a channel, and handlePlanModeAssistant reads it.
	props, ok := schema["properties"].(map[string]any)
	if !ok {
		t.Fatal("ExitPlanMode schema has no properties map")
	}
	if _, ok := props["plan"]; !ok {
		t.Error("ExitPlanMode dropped the `plan` property; it must remain as an optional fallback")
	}

	// The description is the only thing steering the model away from resending
	// a plan it already wrote, so it is load-bearing behavior, not prose.
	if !strings.Contains(desc, "NO arguments") {
		t.Errorf("ExitPlanMode description does not tell the model to call it with no arguments: %q", desc)
	}
}

func TestApplyPlanFileEditReplacesSingleMatch(t *testing.T) {
	planPath := filepath.Join(t.TempDir(), "plan.md")
	writeFile(t, planPath, "# Plan\n\n## Approach\nUse a heuristic.\n")

	got, matches, err := ApplyPlanFileEdit(planPath, "Use a heuristic.", "Use a precise mechanism.")
	if err != nil {
		t.Fatalf("ApplyPlanFileEdit returned error: %v", err)
	}
	if matches != 1 {
		t.Errorf("matches = %d, want 1", matches)
	}
	want := "# Plan\n\n## Approach\nUse a precise mechanism.\n"
	if got != want {
		t.Errorf("content = %q, want %q", got, want)
	}

	// ApplyPlanFileEdit must not write — persistence goes through
	// CapturePlanFileWrite so every mutation emits PlanFileWrittenEvent.
	onDisk := readFile(t, planPath)
	if strings.Contains(onDisk, "precise mechanism") {
		t.Error("ApplyPlanFileEdit wrote to disk; it must only compute the new content")
	}
}

func TestApplyPlanFileEditRejectsAmbiguousAnchor(t *testing.T) {
	planPath := filepath.Join(t.TempDir(), "plan.md")
	writeFile(t, planPath, "step one\nstep one\n")

	_, matches, err := ApplyPlanFileEdit(planPath, "step one", "step two")
	if err != ErrPlanEditAmbiguous {
		t.Errorf("err = %v, want ErrPlanEditAmbiguous", err)
	}
	// The count rides out with the error so the handler can tell the model how
	// many times its anchor matched.
	if matches != 2 {
		t.Errorf("matches = %d, want 2", matches)
	}
}

func TestApplyPlanFileEditReportsMissingAndUnmatched(t *testing.T) {
	dir := t.TempDir()

	if _, _, err := ApplyPlanFileEdit(filepath.Join(dir, "absent.md"), "x", "y"); err != ErrPlanFileMissing {
		t.Errorf("absent file: err = %v, want ErrPlanFileMissing", err)
	}

	empty := filepath.Join(dir, "empty.md")
	writeFile(t, empty, "")
	if _, _, err := ApplyPlanFileEdit(empty, "x", "y"); err != ErrPlanFileMissing {
		t.Errorf("empty file: err = %v, want ErrPlanFileMissing", err)
	}

	populated := filepath.Join(dir, "plan.md")
	writeFile(t, populated, "# Plan\n")
	if _, _, err := ApplyPlanFileEdit(populated, "nowhere", "y"); err != ErrPlanEditNoMatch {
		t.Errorf("unmatched anchor: err = %v, want ErrPlanEditNoMatch", err)
	}
}

// A plan write must announce itself so the preview updates, but must NOT
// propose — writing a plan and presenting it for approval are separate signals,
// and the model writes many times before it exits.
func TestCapturePlanFileWriteEmitsFileEventWithoutProposal(t *testing.T) {
	planPath := filepath.Join(t.TempDir(), "plan.md")
	var emitted []types.NormalizedEvent
	emit := func(_ string, ev types.NormalizedEvent) { emitted = append(emitted, ev) }

	result, err := CapturePlanFileWrite("run-1", "# Plan\n", planPath, emit)
	if err != nil {
		t.Fatalf("CapturePlanFileWrite returned error: %v", err)
	}
	if result.Operation != "created" {
		t.Errorf("Operation = %q, want created", result.Operation)
	}
	if got := readFile(t, planPath); got != "# Plan\n" {
		t.Errorf("plan file content = %q, want %q", got, "# Plan\n")
	}

	var sawWritten, sawProposal bool
	for _, ev := range emitted {
		switch ev.Data.(type) {
		case *types.PlanFileWrittenEvent:
			sawWritten = true
		case *types.PlanProposalEvent:
			sawProposal = true
		}
	}
	if !sawWritten {
		t.Error("no PlanFileWrittenEvent emitted; the plan preview would not update")
	}
	if sawProposal {
		t.Error("PlanProposalEvent emitted on a plan write; only ExitPlanMode proposes a plan")
	}

	// A second write is an update, which is what drives the created-vs-updated
	// distinction consumers render.
	result, err = CapturePlanFileWrite("run-1", "# Plan v2\n", planPath, emit)
	if err != nil {
		t.Fatalf("second CapturePlanFileWrite returned error: %v", err)
	}
	if result.Operation != "updated" {
		t.Errorf("second write Operation = %q, want updated", result.Operation)
	}
}

// The prompt is the only thing that teaches the model the new workflow, so its
// mechanical claims are pinned.
func TestCliPlanModePromptTeachesPlanFileAuthoring(t *testing.T) {
	prompt := buildCliPlanModePrompt("/tmp/plans/brave-otter.md", false)

	for _, want := range []string{"WritePlan", "EditPlan", "/tmp/plans/brave-otter.md", "NO arguments"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("plan prompt missing %q", want)
		}
	}
	// The old prompt asserted the model had no way to write files. That claim
	// is now false and would actively steer the model away from WritePlan.
	if strings.Contains(prompt, "You cannot write files") {
		t.Error("plan prompt still claims the model cannot write files")
	}
}

func schemaOf(fn func() (string, string, map[string]any)) map[string]any {
	_, _, schema := fn()
	return schema
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	return string(raw)
}
