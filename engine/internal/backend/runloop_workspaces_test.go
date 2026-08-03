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

func TestExecuteTools_BenchContinueRefusedWithSiblingTool(t *testing.T) {
	dir := t.TempDir()
	bench := filepath.Join(dir, "integration", "bench")
	if err := os.MkdirAll(bench, 0o755); err != nil {
		t.Fatal(err)
	}
	registryDir := t.TempDir()
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{{
		"repoPath": filepath.Join(dir, "repo"), "sourceBranch": "main", "benchPath": bench,
	}}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(registryDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "bench-continue-sibling",
		conv:      &conversation.Conversation{ID: "conv-bench-continue-sibling"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}, WorkspaceChecker: workspaces.NewCheckerAt(registryDir)},
	}
	blocks := []types.LlmContentBlock{
		{Name: "Bash", ID: "continue", Input: map[string]interface{}{"command": "git merge --continue"}},
		{Name: "Read", ID: "read", Input: map[string]interface{}{"file_path": filepath.Join(bench, "missing")}},
	}

	results, err := b.executeTools(context.Background(), run, blocks, bench)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError || !strings.Contains(results[0].Content, "no sibling tool calls") {
		t.Fatalf("continue must be refused before parallel dispatch: %+v", results[0])
	}
	if results[1].ToolUseID != "read" {
		t.Fatalf("sibling tool must retain normal dispatch: %+v", results[1])
	}
}

func TestExecuteTools_UnsafeBenchContinueRefusedWithSiblingTool(t *testing.T) {
	dir := t.TempDir()
	bench := filepath.Join(dir, "integration", "bench")
	if err := os.MkdirAll(bench, 0o755); err != nil {
		t.Fatal(err)
	}
	registryDir := t.TempDir()
	payload := map[string]any{"version": 1, "workspaces": []map[string]any{{
		"repoPath": filepath.Join(dir, "repo"), "sourceBranch": "main", "benchPath": bench,
	}}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(registryDir, "integration-workspaces.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "unsafe-bench-continue-sibling",
		conv:      &conversation.Conversation{ID: "conv-unsafe-bench-continue-sibling"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}, WorkspaceChecker: workspaces.NewCheckerAt(registryDir)},
	}
	blocks := []types.LlmContentBlock{
		{Name: "Bash", ID: "continue", Input: map[string]interface{}{"command": "git merge --continue >out"}},
		{Name: "Read", ID: "read", Input: map[string]interface{}{"file_path": filepath.Join(bench, "missing")}},
	}

	results, err := b.executeTools(context.Background(), run, blocks, bench)
	if err != nil {
		t.Fatal(err)
	}
	if !results[0].IsError || !strings.Contains(results[0].Content, "no sibling tool calls") {
		t.Fatalf("unsafe continue attempt must retain same-response refusal: %+v", results[0])
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
