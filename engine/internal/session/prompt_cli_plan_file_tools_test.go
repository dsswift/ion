package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for the WritePlan/EditPlan handlers exposed to a delegated claude-code
// plan-mode run.
//
// The behavior that matters most here is WHERE the write lands. The handlers
// take no path, so the target is whatever the session says it is at call time —
// which is what makes a plan authored on one run and revised on another resolve
// to the same file.

// planToolSession starts a session already in plan mode with a plan file inside
// a temp dir, and returns the manager, session key, and plan path.
//
// The plan file is seeded EMPTY: SetPlanMode only adopts a client-supplied path
// that already exists on disk (see its restore guard), and a zero-byte file is
// still "no plan authored yet" everywhere downstream — capturePlanMarkdown
// reports the first write as "created", and ApplyPlanFileEdit treats it as
// ErrPlanFileMissing.
func planToolSession(t *testing.T, key string) (*Manager, string, string) {
	t.Helper()
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	planPath := seedPlanFile(t, filepath.Join(t.TempDir(), "plans", "brave-otter.md"), "")
	mgr.SetPlanMode(key, true, []string{"Read"}, "test", planPath)

	_, got := mgr.GetPlanModeState(key)
	if got != planPath {
		t.Fatalf("session plan path = %q, want %q", got, planPath)
	}
	return mgr, key, planPath
}

// seedPlanFile creates a plan file (and its directory) so SetPlanMode's
// on-disk guard adopts the path.
func seedPlanFile(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("seed %s: %v", path, err)
	}
	return path
}

func callTool(t *testing.T, h func(context.Context, map[string]interface{}) (*types.ToolResult, error), input map[string]interface{}) *types.ToolResult {
	t.Helper()
	res, err := h(context.Background(), input)
	if err != nil {
		t.Fatalf("handler returned a transport error: %v", err)
	}
	if res == nil {
		t.Fatal("handler returned a nil result")
	}
	return res
}

func TestWritePlanAuthorsTheSessionPlanFile(t *testing.T) {
	mgr, key, planPath := planToolSession(t, "writeplan-basic")

	res := callTool(t, writePlanToolHandler(mgr, key), map[string]interface{}{
		"content": "# Plan\n\n## Approach\nDo the work.\n",
	})
	if res.IsError {
		t.Fatalf("WritePlan returned an error result: %s", res.Content)
	}

	raw, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("plan file was not written: %v", err)
	}
	if !strings.Contains(string(raw), "Do the work.") {
		t.Errorf("plan file content = %q, want the written plan", string(raw))
	}
	// The result must steer the model away from resending the plan on exit —
	// that redundancy is the cost this whole pair exists to remove.
	if !strings.Contains(res.Content, "ExitPlanMode") {
		t.Errorf("WritePlan result does not mention ExitPlanMode: %q", res.Content)
	}
}

// The core session-scoping property: the handler resolves the path when it is
// CALLED, not when it was registered. A run that registered the tool before the
// session had a plan file must still write to the file the session later got.
func TestWritePlanResolvesPathAtCallTimeNotRegistrationTime(t *testing.T) {
	mgr := NewManager(newMockBackend())
	key := "writeplan-late-path"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	// Registration happens while the session has NO plan file.
	handler := writePlanToolHandler(mgr, key)
	if res := callTool(t, handler, map[string]interface{}{"content": "# Plan\n"}); !res.IsError {
		t.Error("expected an error result while no plan file is allocated")
	}

	// The session enters plan mode afterwards, on what is effectively a later
	// run. The already-registered handler must pick up the new path.
	planPath := seedPlanFile(t, filepath.Join(t.TempDir(), "plans", "late.md"), "")
	mgr.SetPlanMode(key, true, []string{"Read"}, "test", planPath)

	res := callTool(t, handler, map[string]interface{}{"content": "# Plan\n\nauthored later\n"})
	if res.IsError {
		t.Fatalf("WritePlan errored after the plan file existed: %s", res.Content)
	}
	raw, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("plan file was not written at the session's current path: %v", err)
	}
	if !strings.Contains(string(raw), "authored later") {
		t.Errorf("plan file content = %q", string(raw))
	}
}

func TestWritePlanRefusesEmptyContent(t *testing.T) {
	mgr, key, planPath := planToolSession(t, "writeplan-empty")
	if err := os.WriteFile(planPath, []byte("# Existing plan\n"), 0644); err != nil {
		t.Fatalf("seed plan: %v", err)
	}

	res := callTool(t, writePlanToolHandler(mgr, key), map[string]interface{}{"content": ""})
	if !res.IsError {
		t.Error("expected an error result for empty content")
	}
	// An empty write must never blank a plan the model already authored.
	raw, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("reading plan: %v", err)
	}
	if !strings.Contains(string(raw), "Existing plan") {
		t.Error("empty WritePlan blanked the existing plan file")
	}
}

func TestEditPlanRevisesInPlace(t *testing.T) {
	mgr, key, planPath := planToolSession(t, "editplan-basic")

	if res := callTool(t, writePlanToolHandler(mgr, key), map[string]interface{}{
		"content": "# Plan\n\n## Approach\nUse a heuristic.\n",
	}); res.IsError {
		t.Fatalf("seeding WritePlan failed: %s", res.Content)
	}

	res := callTool(t, editPlanToolHandler(mgr, key), map[string]interface{}{
		"old_string": "Use a heuristic.",
		"new_string": "Use a precise mechanism.",
	})
	if res.IsError {
		t.Fatalf("EditPlan returned an error result: %s", res.Content)
	}

	raw, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("reading plan: %v", err)
	}
	got := string(raw)
	if !strings.Contains(got, "Use a precise mechanism.") {
		t.Errorf("plan file was not revised: %q", got)
	}
	if strings.Contains(got, "heuristic") {
		t.Errorf("old text survived the edit: %q", got)
	}
	if !strings.Contains(got, "# Plan") {
		t.Errorf("EditPlan clobbered surrounding content: %q", got)
	}
}

// Every failure arm must name its real cause, so the model corrects the anchor
// instead of falling back to resending the whole plan through WritePlan.
func TestEditPlanFailuresAreActionable(t *testing.T) {
	mgr, key, _ := planToolSession(t, "editplan-failures")

	// Before any plan exists.
	res := callTool(t, editPlanToolHandler(mgr, key), map[string]interface{}{
		"old_string": "x", "new_string": "y",
	})
	if !res.IsError || !strings.Contains(res.Content, "WritePlan") {
		t.Errorf("missing-plan result should point at WritePlan, got: %q", res.Content)
	}

	if res := callTool(t, writePlanToolHandler(mgr, key), map[string]interface{}{
		"content": "step one\nstep one\n",
	}); res.IsError {
		t.Fatalf("seeding WritePlan failed: %s", res.Content)
	}

	// Anchor that matches nothing.
	res = callTool(t, editPlanToolHandler(mgr, key), map[string]interface{}{
		"old_string": "nowhere", "new_string": "y",
	})
	if !res.IsError || !strings.Contains(res.Content, "does not appear") {
		t.Errorf("no-match result should say the anchor was not found, got: %q", res.Content)
	}

	// Anchor that matches more than once — the message must carry the count.
	res = callTool(t, editPlanToolHandler(mgr, key), map[string]interface{}{
		"old_string": "step one", "new_string": "step two",
	})
	if !res.IsError {
		t.Fatal("expected an error result for an ambiguous anchor")
	}
	if !strings.Contains(res.Content, "2 times") {
		t.Errorf("ambiguous result should report the match count, got: %q", res.Content)
	}
}

// A plan write must reach consumers, or the plan preview never updates.
func TestPlanFileToolsEmitPlanFileWrittenEvent(t *testing.T) {
	mgr, key, _ := planToolSession(t, "planfile-events")

	var mu sync.Mutex
	var writes int
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if strings.Contains(string(ev.Type), "plan_file_written") {
			mu.Lock()
			writes++
			mu.Unlock()
		}
	})

	if res := callTool(t, writePlanToolHandler(mgr, key), map[string]interface{}{
		"content": "# Plan\n\noriginal\n",
	}); res.IsError {
		t.Fatalf("WritePlan failed: %s", res.Content)
	}
	if res := callTool(t, editPlanToolHandler(mgr, key), map[string]interface{}{
		"old_string": "original", "new_string": "revised",
	}); res.IsError {
		t.Fatalf("EditPlan failed: %s", res.Content)
	}

	mu.Lock()
	got := writes
	mu.Unlock()
	if got < 2 {
		t.Errorf("plan_file_written events = %d, want one per authoring call (2)", got)
	}
}
