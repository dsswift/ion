package tools

// Tests for the three cross-worktree query tool wrappers (WorktreeList,
// WorktreeCommits, WorktreeDiff). The workspaces package itself is
// exhaustively tested against real git fixtures
// (internal/workspaces/worktree_*_test.go) — these tests pin the tool-layer
// concerns: input validation, JSON shape, PlanModeSafe, and registration,
// using workspaces.SetSharedCheckerForTest to point ExecuteTool at a small
// real fixture rather than re-deriving the underlying git behavior.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/workspaces"
)

// worktreeToolFixture builds one repo with one linked worktree on "wt/mine",
// registers it, and points the shared checker there for the test's lifetime.
func worktreeToolFixture(t *testing.T) (repo, wt string) {
	t.Helper()
	root := t.TempDir()
	repo = filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Dev", "GIT_AUTHOR_EMAIL=dev@example.com",
			"GIT_COMMITTER_NAME=Dev", "GIT_COMMITTER_EMAIL=dev@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run(repo, "init", "-b", "main")
	run(repo, "config", "user.email", "dev@example.com")
	run(repo, "config", "user.name", "Dev")
	run(repo, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(repo, "add", "-A")
	run(repo, "commit", "-m", "base commit")

	wt = filepath.Join(root, "wt-mine")
	run(repo, "worktree", "add", "-b", "wt/mine", wt, "main")
	if err := os.WriteFile(filepath.Join(wt, "feature.txt"), []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(wt, "add", "-A")
	run(wt, "commit", "-m", "wt/mine commit 1")

	regDir := t.TempDir()
	raw, err := json.Marshal(map[string]any{
		"version": 1,
		"entries": []map[string]any{
			{"worktreePath": wt, "repoPath": repo, "branchName": "wt/mine", "sourceBranch": "main"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(regDir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(workspaces.SetSharedCheckerForTest(workspaces.NewCheckerAt(regDir)))
	return repo, wt
}

// ─── WorktreeList ────────────────────────────────────────────────────────────

func TestWorktreeListTool_PlanModeSafe(t *testing.T) {
	if !WorktreeListTool().PlanModeSafe {
		t.Error("WorktreeList must be PlanModeSafe: it only reads")
	}
}

func TestWorktreeListTool_ReturnsEntries(t *testing.T) {
	_, wt := worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeList", map[string]any{}, wt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected tool error: %s", result.Content)
	}
	var parsed workspaces.WorktreeListResult
	if err := json.Unmarshal([]byte(result.Content), &parsed); err != nil {
		t.Fatalf("result must be valid JSON matching WorktreeListResult: %v\n%s", err, result.Content)
	}
	if len(parsed.Entries) != 1 || parsed.Entries[0].BranchName != "wt/mine" {
		t.Fatalf("expected the registered worktree in entries, got %+v", parsed.Entries)
	}
	if !parsed.Entries[0].IsSelf {
		t.Error("the entry matching the calling cwd must be IsSelf")
	}
}

func TestWorktreeListTool_UnrelatedCwdIsError(t *testing.T) {
	worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeList", map[string]any{}, t.TempDir())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("an unrelated cwd must produce a tool error result carrying the rejection")
	}
}

// ─── WorktreeCommits ─────────────────────────────────────────────────────────

func TestWorktreeCommitsTool_PlanModeSafe(t *testing.T) {
	if !WorktreeCommitsTool().PlanModeSafe {
		t.Error("WorktreeCommits must be PlanModeSafe: it only reads")
	}
}

func TestWorktreeCommitsTool_DefaultsToOwnBranch(t *testing.T) {
	_, wt := worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeCommits", map[string]any{}, wt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected tool error: %s", result.Content)
	}
	var parsed workspaces.CommitsResult
	if err := json.Unmarshal([]byte(result.Content), &parsed); err != nil {
		t.Fatalf("result must be valid JSON matching CommitsResult: %v\n%s", err, result.Content)
	}
	if parsed.BranchName != "wt/mine" {
		t.Errorf("branch = %q, want wt/mine", parsed.BranchName)
	}
	if len(parsed.Commits) == 0 {
		t.Fatal("expected at least one commit")
	}
}

func TestWorktreeCommitsTool_RejectsNonIntegerLimit(t *testing.T) {
	worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeCommits", map[string]any{"limit": "not a number"}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("a non-integer limit must be rejected as input error")
	}
	if !strings.Contains(result.Content, "limit must be an integer") {
		t.Errorf("expected actionable message, got %q", result.Content)
	}
}

func TestWorktreeCommitsTool_RejectsZeroLimit(t *testing.T) {
	worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeCommits", map[string]any{"limit": float64(0)}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("a zero limit must be rejected")
	}
}

// ─── WorktreeDiff ────────────────────────────────────────────────────────────

func TestWorktreeDiffTool_PlanModeSafe(t *testing.T) {
	if !WorktreeDiffTool().PlanModeSafe {
		t.Error("WorktreeDiff must be PlanModeSafe: it only reads")
	}
}

func TestWorktreeDiffTool_CumulativeModeAgainstSourceBranch(t *testing.T) {
	_, wt := worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeDiff", map[string]any{}, wt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected tool error: %s", result.Content)
	}
	var parsed workspaces.DiffResult
	if err := json.Unmarshal([]byte(result.Content), &parsed); err != nil {
		t.Fatalf("result must be valid JSON matching DiffResult: %v\n%s", err, result.Content)
	}
	if parsed.Mode != "cumulative" || parsed.Against != "main" {
		t.Errorf("mode/against = %q/%q, want cumulative/main", parsed.Mode, parsed.Against)
	}
	if !strings.Contains(parsed.Patch, "feature.txt") {
		t.Errorf("patch must show the committed file, got: %s", parsed.Patch)
	}
}

func TestWorktreeDiffTool_UnknownWorktreeIsError(t *testing.T) {
	_, wt := worktreeToolFixture(t)

	result, err := ExecuteTool(context.Background(), "WorktreeDiff", map[string]any{"worktree": "wt/does-not-exist"}, wt)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Fatal("an unresolvable worktree must produce a tool error")
	}
}

// ─── Registration ────────────────────────────────────────────────────────────

func TestWorktreeQueryTools_Registered(t *testing.T) {
	for _, name := range []string{WorktreeListName, WorktreeCommitsName, WorktreeDiffName} {
		if GetTool(name) == nil {
			t.Errorf("expected %q to be registered as a built-in tool", name)
		}
	}
}
