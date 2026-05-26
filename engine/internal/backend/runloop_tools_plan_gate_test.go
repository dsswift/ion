package backend

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
)

// planGateHelper creates an ApiBackend + activeRun wired for plan-mode
// write gate tests. Returns the backend, the run, and a slice that
// collects emitted events.
func planGateHelper(t *testing.T, planMode bool, planFilePath string) (*ApiBackend, *activeRun, *[]types.NormalizedEvent) {
	t.Helper()
	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) {
		emitted = append(emitted, ev)
	})
	run := &activeRun{
		requestID:    "test-req",
		planMode:     planMode,
		planFilePath: planFilePath,
	}
	return b, run, &emitted
}

// Test 1: Write to plan file is allowed
func TestPlanGate_WriteToplanFileAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	if err := os.WriteFile(planFile, []byte("# plan"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-1",
		Input: map[string]interface{}{"file_path": planFile, "content": "# updated plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected Write to plan file to succeed, got error: %s", results[0].Content)
	}
}

// Test 2: Write to wrong file is blocked
func TestPlanGate_WriteToWrongFileBlocked(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	otherFile := filepath.Join(t.TempDir(), "other-file.md")
	b, run, emitted := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-2",
		Input: map[string]interface{}{"file_path": otherFile, "content": "nope"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError {
		t.Error("expected Write to wrong file to be blocked")
	}
	if !strings.Contains(results[0].Content, "Plan mode: cannot write to") {
		t.Errorf("expected plan-mode error message, got: %s", results[0].Content)
	}
	// The file must not exist on disk — the gate blocked before execution.
	if _, err := os.Stat(otherFile); err == nil {
		t.Error("blocked file should not exist on disk")
	}
	// Verify an error event was emitted.
	found := false
	for _, ev := range *emitted {
		if tr, ok := ev.Data.(*types.ToolResultEvent); ok && tr.IsError {
			found = true
		}
	}
	if !found {
		t.Error("expected an error ToolResultEvent to be emitted")
	}
}

// Test 3: Edit to plan file is allowed
func TestPlanGate_EditToPlanFileAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	if err := os.WriteFile(planFile, []byte("old content"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name: "Edit",
		ID:   "tc-3",
		Input: map[string]interface{}{
			"file_path":  planFile,
			"old_string": "old content",
			"new_string": "new content",
		},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected Edit to plan file to succeed, got error: %s", results[0].Content)
	}
}

// Test 4: Edit to wrong file is blocked
func TestPlanGate_EditToWrongFileBlocked(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	otherFile := filepath.Join(t.TempDir(), "other.md")
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name: "Edit",
		ID:   "tc-4",
		Input: map[string]interface{}{
			"file_path":  otherFile,
			"old_string": "a",
			"new_string": "b",
		},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError {
		t.Error("expected Edit to wrong file to be blocked")
	}
	if !strings.Contains(results[0].Content, "Plan mode: cannot write to") {
		t.Errorf("expected plan-mode error message, got: %s", results[0].Content)
	}
}

// Test 5: Path normalization — equivalent paths that differ in string form
// This is the exact bug that caused the original incident. The model emits
// a path like "/tmp/plans/../plans/plan.md" which is equivalent to
// "/tmp/plans/plan.md". With filepath.Clean both resolve to the same path.
func TestPlanGate_PathNormalizationAllowed(t *testing.T) {
	dir := t.TempDir()
	planDir := filepath.Join(dir, "plans")
	if err := os.MkdirAll(planDir, 0755); err != nil {
		t.Fatal(err)
	}
	planFile := filepath.Join(planDir, "happy-jumping-rabbit.md")
	if err := os.WriteFile(planFile, []byte("# plan"), 0644); err != nil {
		t.Fatal(err)
	}
	b, run, _ := planGateHelper(t, true, planFile)

	// Model uses an equivalent but string-different path.
	normalizedEquivalent := filepath.Join(dir, "plans", "..", "plans", "happy-jumping-rabbit.md")
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-5",
		Input: map[string]interface{}{"file_path": normalizedEquivalent, "content": "# updated plan"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if results[0].IsError {
		t.Errorf("expected normalized-equivalent path to be allowed, got error: %s", results[0].Content)
	}
}

// Test 6: Plan mode off — Write to any file is not gated
func TestPlanGate_PlanModeOff_NoGate(t *testing.T) {
	anyFile := filepath.Join(t.TempDir(), "any-file.md")
	b, run, _ := planGateHelper(t, false, "")

	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-6",
		Input: map[string]interface{}{"file_path": anyFile, "content": "hello"},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// The Write tool will execute (and succeed or fail based on tool logic),
	// but the plan mode gate must NOT fire. We check that there's no
	// "Plan mode: cannot write to" error — the gate didn't intervene.
	if results[0].IsError && strings.Contains(results[0].Content, "Plan mode:") {
		t.Error("plan mode gate should not fire when planMode is false")
	}
}

// Test 7: Read-only tools are allowed in plan mode
func TestPlanGate_ReadOnlyToolsAllowed(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	b, run, _ := planGateHelper(t, true, planFile)

	// Read tool — targets a file that exists.
	readTarget := filepath.Join(t.TempDir(), "readable.txt")
	if err := os.WriteFile(readTarget, []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	blocks := []types.LlmContentBlock{{
		Name:  "Read",
		ID:    "tc-7",
		Input: map[string]interface{}{"file_path": readTarget},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Read should succeed (not blocked by plan gate). It may have its own
	// errors, but not plan-mode errors.
	if results[0].IsError && strings.Contains(results[0].Content, "Plan mode:") {
		t.Error("Read tool should not be blocked by plan mode write gate")
	}
}

// Test 8: ExitPlanMode sentinel is intercepted in plan mode
func TestPlanGate_ExitPlanModeIntercepted(t *testing.T) {
	planFile := filepath.Join(t.TempDir(), "test-plan.md")
	b, run, _ := planGateHelper(t, true, planFile)

	blocks := []types.LlmContentBlock{{
		Name:  tools.ExitPlanModeName,
		ID:    "tc-8",
		Input: map[string]interface{}{},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// ExitPlanMode is intercepted — it's not routed to a real tool executor.
	// The run should be flagged for exit.
	run.mu.Lock()
	exited := run.exitPlanMode
	run.mu.Unlock()
	if !exited {
		t.Error("expected ExitPlanMode to set run.exitPlanMode = true")
	}
	// The result should not be an error (it's a successful interception).
	if results[0].IsError {
		t.Errorf("ExitPlanMode result should not be an error, got: %s", results[0].Content)
	}
}

// Test 9: ExitPlanMode in auto mode falls through to unknown tool
func TestPlanGate_ExitPlanModeAutoModeFallthrough(t *testing.T) {
	b, run, _ := planGateHelper(t, false, "")

	blocks := []types.LlmContentBlock{{
		Name:  tools.ExitPlanModeName,
		ID:    "tc-9",
		Input: map[string]interface{}{},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// In auto mode, ExitPlanMode is not intercepted — it falls through
	// to the "Unknown tool" handler.
	if !results[0].IsError {
		t.Error("expected ExitPlanMode in auto mode to produce an error (unknown tool)")
	}
	if !strings.Contains(results[0].Content, "Unknown tool") {
		t.Errorf("expected 'Unknown tool' error, got: %s", results[0].Content)
	}
}
