package backend

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// collectEmits returns an emit sink appending every event to the returned slice.
func collectEmits() (func(string, types.NormalizedEvent), *[]types.NormalizedEvent) {
	var events []types.NormalizedEvent
	return func(_ string, ev types.NormalizedEvent) {
		events = append(events, ev)
	}, &events
}

func TestCapturePlanMarkdown_CreatesFileAndEmitsInOrder(t *testing.T) {
	dir := t.TempDir()
	planPath := filepath.Join(dir, "brave-blue-fox.md")
	emit, events := collectEmits()

	res, err := capturePlanMarkdown("run-1", "# Plan\n\ndo the thing\n", planPath, true, 0, emit)
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if res.Operation != "created" {
		t.Fatalf("operation = %q, want created", res.Operation)
	}
	data, err := os.ReadFile(planPath)
	if err != nil {
		t.Fatalf("plan file not written: %v", err)
	}
	if string(data) != "# Plan\n\ndo the thing\n" {
		t.Fatalf("plan file content mismatch: %q", string(data))
	}

	if len(*events) != 2 {
		t.Fatalf("expected 2 events, got %d", len(*events))
	}
	written, ok := (*events)[0].Data.(*types.PlanFileWrittenEvent)
	if !ok {
		t.Fatalf("event[0] = %T, want PlanFileWrittenEvent first", (*events)[0].Data)
	}
	if written.Operation != "created" || written.PlanFilePath != planPath || written.PlanSlug != "brave-blue-fox" {
		t.Fatalf("PlanFileWrittenEvent fields wrong: %+v", written)
	}
	proposal, ok := (*events)[1].Data.(*types.PlanProposalEvent)
	if !ok {
		t.Fatalf("event[1] = %T, want PlanProposalEvent second", (*events)[1].Data)
	}
	if proposal.Kind != "exit" || proposal.PlanFilePath != planPath || proposal.PlanSlug != "brave-blue-fox" {
		t.Fatalf("PlanProposalEvent fields wrong: %+v", proposal)
	}
}

func TestCapturePlanMarkdown_UpdatedWhenFileHadContent(t *testing.T) {
	dir := t.TempDir()
	planPath := filepath.Join(dir, "plan.md")
	if err := os.WriteFile(planPath, []byte("old plan"), 0644); err != nil {
		t.Fatal(err)
	}
	emit, events := collectEmits()

	res, err := capturePlanMarkdown("run-2", "new plan", planPath, true, 0, emit)
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if res.Operation != "updated" {
		t.Fatalf("operation = %q, want updated", res.Operation)
	}
	written := (*events)[0].Data.(*types.PlanFileWrittenEvent)
	if written.Operation != "updated" {
		t.Fatalf("event operation = %q, want updated", written.Operation)
	}
	data, _ := os.ReadFile(planPath)
	if string(data) != "new plan" {
		t.Fatalf("plan file not replaced: %q", string(data))
	}
}

func TestCapturePlanMarkdown_NoProposalWhenNotRequested(t *testing.T) {
	dir := t.TempDir()
	emit, events := collectEmits()

	_, err := capturePlanMarkdown("run-3", "plan body", filepath.Join(dir, "p.md"), false, 0, emit)
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if len(*events) != 1 {
		t.Fatalf("expected 1 event (file written only), got %d", len(*events))
	}
	if _, ok := (*events)[0].Data.(*types.PlanFileWrittenEvent); !ok {
		t.Fatalf("event[0] = %T, want PlanFileWrittenEvent", (*events)[0].Data)
	}
}

func TestCapturePlanMarkdown_EmptyInputsAreNoOps(t *testing.T) {
	dir := t.TempDir()
	planPath := filepath.Join(dir, "p.md")
	emit, events := collectEmits()

	res, err := capturePlanMarkdown("run-4", "", planPath, true, 0, emit)
	if err != nil || res.Operation != "" {
		t.Fatalf("empty markdown: res=%+v err=%v, want no-op", res, err)
	}
	res, err = capturePlanMarkdown("run-4", "plan", "", true, 0, emit)
	if err != nil || res.Operation != "" {
		t.Fatalf("empty path: res=%+v err=%v, want no-op", res, err)
	}
	if len(*events) != 0 {
		t.Fatalf("no-op emitted %d events", len(*events))
	}
	if _, err := os.Stat(planPath); !os.IsNotExist(err) {
		t.Fatal("no-op created the plan file")
	}
}

func TestCapturePlanMarkdown_TruncatesToCapWithMarker(t *testing.T) {
	dir := t.TempDir()
	planPath := filepath.Join(dir, "p.md")
	emit, _ := collectEmits()

	long := strings.Repeat("x", 100)
	res, err := capturePlanMarkdown("run-5", long, planPath, true, 32, emit)
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	data, _ := os.ReadFile(planPath)
	if !strings.HasSuffix(string(data), planTruncationMarker) {
		t.Fatalf("truncated plan missing marker: %q", string(data))
	}
	if !strings.HasPrefix(string(data), strings.Repeat("x", 32)) {
		t.Fatalf("truncated plan body wrong: %q", string(data))
	}
	if res.BytesWritten != len(data) {
		t.Fatalf("BytesWritten=%d, file=%d", res.BytesWritten, len(data))
	}
}

func TestCapturePlanMarkdown_TruncationRespectsRuneBoundary(t *testing.T) {
	dir := t.TempDir()
	planPath := filepath.Join(dir, "p.md")
	emit, _ := collectEmits()

	// "é" is 2 bytes; a 3-byte cap lands mid-rune and must back up.
	if _, err := capturePlanMarkdown("run-6", "aéé", planPath, false, 3, emit); err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	data, _ := os.ReadFile(planPath)
	body := strings.TrimSuffix(string(data), planTruncationMarker)
	if body != "aé" {
		t.Fatalf("rune-boundary truncation wrong: %q", body)
	}
}

func TestCapturePlanMarkdown_LeavesNoTempFile(t *testing.T) {
	dir := t.TempDir()
	emit, _ := collectEmits()
	if _, err := capturePlanMarkdown("run-7", "plan", filepath.Join(dir, "p.md"), true, 0, emit); err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestResolveCliPlanModeAutoExit(t *testing.T) {
	if !resolveCliPlanModeAutoExit(nil) {
		t.Fatal("nil opts must default to true")
	}
	if !resolveCliPlanModeAutoExit(&types.RunOptions{}) {
		t.Fatal("nil pointer must default to true")
	}
	f, tr := false, true
	if resolveCliPlanModeAutoExit(&types.RunOptions{PlanModeAutoExit: &f}) {
		t.Fatal("&false must disable auto-exit")
	}
	if !resolveCliPlanModeAutoExit(&types.RunOptions{PlanModeAutoExit: &tr}) {
		t.Fatal("&true must enable auto-exit")
	}
}

func TestResolveCodexPlanInstructions(t *testing.T) {
	if got := resolveCodexPlanInstructions(&types.RunOptions{PlanModePrompt: "custom"}); got != "custom" {
		t.Fatalf("harness override not honored: %q", got)
	}
	def := resolveCodexPlanInstructions(&types.RunOptions{})
	if def == "" || def != defaultCodexDeveloperInstructions() {
		t.Fatalf("default not returned: %q", def)
	}
	// The <proposed_plan> convention is the mechanics-bearing part: without it
	// codex won't emit a plan item to capture. Pin that the default carries it.
	if !strings.Contains(def, "<proposed_plan>") || !strings.Contains(def, "</proposed_plan>") {
		t.Fatalf("default developer_instructions missing <proposed_plan> convention: %q", def)
	}
}
