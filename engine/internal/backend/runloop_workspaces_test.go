package backend

// Run-loop enforcement of workspace containment — the wiring half of
// internal/workspaces. The package's own tests pin the policy; these pin that
// the tool loop actually consults it, records the refusal as the tool result,
// and emits the workspace_containment failure category.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// workspaceRunFixture builds a registry with one worktree and returns a
// checker over it plus the paths involved.
func workspaceRunFixture(t *testing.T) (checker *workspaces.Checker, worktree, repo string) {
	t.Helper()
	dir := t.TempDir()
	repo = "/repo/project"
	worktree = "/wt/project-aaa"
	payload := map[string]any{"version": 1, "entries": []map[string]any{
		{"worktreePath": worktree, "repoPath": repo},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return workspaces.NewCheckerAt(dir), worktree, repo
}

// TestExecuteTools_WorkspaceContainmentRefusesBaseRepoWrite pins the live
// incident this feature exists for: a worktree conversation's Write into the
// base repo must come back as an error tool result carrying the refusal
// reason, with the workspace_containment failure category emitted — and the
// file must never be written (the tool itself must not run).
func TestExecuteTools_WorkspaceContainmentRefusesBaseRepoWrite(t *testing.T) {
	checker, worktree, repo := workspaceRunFixture(t)

	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) { emitted = append(emitted, ev) })
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "ws-req",
		conv:      &conversation.Conversation{ID: "conv-ws"},
		cfg:       &RunConfig{Telemetry: telem, WorkspaceChecker: checker},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-ws",
		Input: map[string]interface{}{"file_path": repo + "/x.go", "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, worktree)
	if err != nil {
		t.Fatal(err)
	}

	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected one error result, got %+v", results)
	}
	if !strings.Contains(results[0].Content, worktree) {
		t.Errorf("refusal must name the worktree to write in: %s", results[0].Content)
	}
	if !failureCategories(telem)["workspace_containment"] {
		t.Error("expected a tool.failure event with category workspace_containment")
	}
	// The target must not exist: the refusal fired BEFORE tool execution.
	if _, statErr := os.Stat(repo + "/x.go"); statErr == nil {
		t.Error("refused Write still created the file")
	}
}

// TestExecuteTools_WorkspaceContainmentPassesOwnWorktree pins the other half:
// a write inside the conversation's own worktree reaches the tool untouched.
func TestExecuteTools_WorkspaceContainmentPassesOwnWorktree(t *testing.T) {
	// Use a REAL temp worktree path so the Write tool can succeed.
	dir := t.TempDir()
	realWorktree := filepath.Join(dir, "wt-real")
	if err := os.MkdirAll(realWorktree, 0o755); err != nil {
		t.Fatal(err)
	}
	regDir := t.TempDir()
	payload := map[string]any{"version": 1, "entries": []map[string]any{
		{"worktreePath": realWorktree, "repoPath": filepath.Join(dir, "repo")},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(regDir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "ws-pass-req",
		conv:      &conversation.Conversation{ID: "conv-ws-pass"},
		cfg:       &RunConfig{Telemetry: telem, WorkspaceChecker: workspaces.NewCheckerAt(regDir)},
	}
	target := filepath.Join(realWorktree, "ok.txt")
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-ws-pass",
		Input: map[string]interface{}{"file_path": target, "content": "allowed"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, realWorktree)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].IsError {
		t.Fatalf("own-worktree write must pass, got %+v", results)
	}
	if _, statErr := os.Stat(target); statErr != nil {
		t.Errorf("allowed Write did not create the file: %v", statErr)
	}
	if failureCategories(telem)["workspace_containment"] {
		t.Error("no workspace_containment failure expected for an allowed write")
	}
}

// TestExecuteTools_WorkspaceContainmentRefusesLandedWorktreeWrite pins the
// sealed-worktree enforcement: a Write inside a landed worktree must come back
// as an error result with workspace_containment, even though the target is
// inside the conversation's own worktree.
func TestExecuteTools_WorkspaceContainmentRefusesLandedWorktreeWrite(t *testing.T) {
	dir := t.TempDir()
	repo := "/repo/project"
	worktree := "/wt/project-landed"
	payload := map[string]any{"version": 1, "entries": []map[string]any{
		{"worktreePath": worktree, "repoPath": repo, "landedAt": 1700000500000},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	checker := workspaces.NewCheckerAt(dir)

	b := NewApiBackend()
	var emitted []types.NormalizedEvent
	b.OnNormalized(func(_ string, ev types.NormalizedEvent) { emitted = append(emitted, ev) })
	var decisionFields map[string]any
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag == "workspaces" && msg == "workspace containment decision" {
			decisionFields = fields
		}
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	telem := &mockTelemetry{}
	run := &activeRun{
		requestID: "ws-landed-req",
		conv:      &conversation.Conversation{ID: "conv-ws-landed"},
		cfg:       &RunConfig{Telemetry: telem, WorkspaceChecker: checker},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-ws-landed",
		Input: map[string]interface{}{"file_path": worktree + "/x.go", "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, worktree)
	if err != nil {
		t.Fatal(err)
	}

	if len(results) != 1 || !results[0].IsError {
		t.Fatalf("expected one error result for landed worktree, got %+v", results)
	}
	if !strings.Contains(results[0].Content, "sealed") {
		t.Errorf("refusal must mention sealed: %s", results[0].Content)
	}
	if !failureCategories(telem)["workspace_containment"] {
		t.Error("expected workspace_containment failure category")
	}
	if decisionFields["decision"] != "deny" || decisionFields["kind"] != string(workspaces.RefusalLandedWorktree) || decisionFields["target"] != worktree || decisionFields["run_id"] != "ws-landed-req" || decisionFields["reason"] != results[0].Content {
		t.Errorf("sealed refusal log fields = %+v", decisionFields)
	}
	if len(emitted) != 1 {
		t.Fatalf("expected one refusal ToolResultEvent, got %+v", emitted)
	}
	resultEvent, ok := emitted[0].Data.(*types.ToolResultEvent)
	if !ok || !resultEvent.IsError || resultEvent.ToolID != "tc-ws-landed" {
		t.Errorf("sealed refusal must emit error ToolResultEvent for tc-ws-landed, got %+v", emitted[0].Data)
	}
}

// TestExecuteTools_NilWorkspaceCheckerPassesEverything pins the disabled
// state: SecurityConfig.WorkspaceContainment=false threads a nil checker and
// the loop must not refuse anything.
func TestExecuteTools_NilWorkspaceCheckerPassesEverything(t *testing.T) {
	dir := t.TempDir()
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "ws-nil-req",
		conv:      &conversation.Conversation{ID: "conv-ws-nil"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}},
	}
	target := filepath.Join(dir, "anywhere.txt")
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-ws-nil",
		Input: map[string]interface{}{"file_path": target, "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].IsError {
		t.Fatalf("nil checker must pass, got %+v", results)
	}
}
