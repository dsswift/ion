package workspaces

// Structured-log coverage for the cross-worktree query tools (WorktreeList,
// WorktreeCommits, WorktreeDiff). Each tool follows the same pattern:
// start → rejection or failure → success, all through utils.LogWithFields
// with tag "workspaces". These tests use utils.SetTestSink to capture log
// records and verify the structured fields on each path.

import (
	"context"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// logRecord captures one structured log line for assertion.
type logRecord struct {
	level  utils.LogLevel
	tag    string
	msg    string
	fields map[string]any
}

// logCapture installs a test sink that records all log lines with
// tag "workspaces". Returns a function that retrieves the captured records.
// Caller must defer the returned cleanup to remove the sink.
func logCapture(t *testing.T) (records func() []logRecord, cleanup func()) {
	t.Helper()
	prevLevel := utils.LevelDebug
	utils.SetLevel(utils.LevelDebug)

	var mu sync.Mutex
	var recs []logRecord
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag != logTag {
			return
		}
		mu.Lock()
		recs = append(recs, logRecord{level: level, tag: tag, msg: msg, fields: copyFields(fields)})
		mu.Unlock()
	})
	return func() []logRecord {
			mu.Lock()
			defer mu.Unlock()
			out := make([]logRecord, len(recs))
			copy(out, recs)
			return out
		}, func() {
			utils.SetTestSink(nil)
			utils.SetLevel(prevLevel)
		}
}

func copyFields(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func findLog(recs []logRecord, msg string) *logRecord {
	for i := range recs {
		if recs[i].msg == msg {
			return &recs[i]
		}
	}
	return nil
}

// ── WorktreeList log coverage ────────────────────────────────────────────────

func TestWorktreeListLogs_NilChecker(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	var c *Checker
	c.WorktreeList(context.Background(), "/some/dir")

	recs := records()
	if r := findLog(recs, "worktree list start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree list rejected")
	if r == nil {
		t.Fatal("must log rejection for nil checker")
	}
	if r.fields["reason"] != "nil_checker" {
		t.Errorf("reason = %v, want nil_checker", r.fields["reason"])
	}
}

func TestWorktreeListLogs_UnrelatedDirectory(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: "/wt/a", RepoPath: "/repo", BranchName: "wt/a"},
	})
	c := NewCheckerAt(regDir)
	c.WorktreeList(context.Background(), "/unrelated/dir")

	recs := records()
	r := findLog(recs, "worktree list rejected")
	if r == nil {
		t.Fatal("must log rejection for unrelated directory")
	}
	if r.fields["reason"] != "unrelated_directory" {
		t.Errorf("reason = %v, want unrelated_directory", r.fields["reason"])
	}
}

func TestWorktreeListLogs_Success(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)
	records, cleanup := logCapture(t)
	defer cleanup()

	checker.WorktreeList(context.Background(), wtA)

	recs := records()
	if r := findLog(recs, "worktree list start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree list success")
	if r == nil {
		t.Fatal("must log success")
	}
	if r.fields["entry_count"] == nil {
		t.Error("success log must include entry_count")
	}
}

// ── WorktreeCommits log coverage ─────────────────────────────────────────────

func TestWorktreeCommitsLogs_NilChecker(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	var c *Checker
	c.Commits(context.Background(), CommitsRequest{Cwd: "/some/dir"})

	recs := records()
	if r := findLog(recs, "worktree commits start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree commits rejected")
	if r == nil {
		t.Fatal("must log rejection for nil checker")
	}
	if r.fields["reason"] != "nil_checker" {
		t.Errorf("reason = %v, want nil_checker", r.fields["reason"])
	}
}

func TestWorktreeCommitsLogs_ResolveFailed(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: "/wt/a", RepoPath: "/repo", BranchName: "wt/a"},
	})
	c := NewCheckerAt(regDir)
	c.Commits(context.Background(), CommitsRequest{Cwd: "/unrelated"})

	recs := records()
	r := findLog(recs, "worktree commits rejected")
	if r == nil {
		t.Fatal("must log rejection for resolve failure")
	}
	if r.fields["reason"] != "resolve_failed" {
		t.Errorf("reason = %v, want resolve_failed", r.fields["reason"])
	}
}

func TestWorktreeCommitsLogs_NoBranchName(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	regDir := t.TempDir()
	wtPath := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: wtPath, RepoPath: "/repo"},
	})
	c := NewCheckerAt(regDir)
	c.Commits(context.Background(), CommitsRequest{Cwd: wtPath})

	recs := records()
	r := findLog(recs, "worktree commits rejected")
	if r == nil {
		t.Fatal("must log rejection for no branch name")
	}
	if r.fields["reason"] != "no_branch_name" {
		t.Errorf("reason = %v, want no_branch_name", r.fields["reason"])
	}
}

func TestWorktreeCommitsLogs_Success(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)
	records, cleanup := logCapture(t)
	defer cleanup()

	checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Worktree: "wt/a"})

	recs := records()
	if r := findLog(recs, "worktree commits start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree commits success")
	if r == nil {
		t.Fatal("must log success")
	}
	if r.fields["commit_count"] == nil {
		t.Error("success log must include commit_count")
	}
}

// ── WorktreeDiff log coverage ────────────────────────────────────────────────

func TestWorktreeDiffLogs_NilChecker(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	var c *Checker
	c.Diff(context.Background(), DiffRequest{Cwd: "/some/dir"})

	recs := records()
	if r := findLog(recs, "worktree diff start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree diff rejected")
	if r == nil {
		t.Fatal("must log rejection for nil checker")
	}
	if r.fields["reason"] != "nil_checker" {
		t.Errorf("reason = %v, want nil_checker", r.fields["reason"])
	}
}

func TestWorktreeDiffLogs_ResolveFailed(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: "/wt/a", RepoPath: "/repo", BranchName: "wt/a"},
	})
	c := NewCheckerAt(regDir)
	c.Diff(context.Background(), DiffRequest{Cwd: "/unrelated"})

	recs := records()
	r := findLog(recs, "worktree diff rejected")
	if r == nil {
		t.Fatal("must log rejection for resolve failure")
	}
	if r.fields["reason"] != "resolve_failed" {
		t.Errorf("reason = %v, want resolve_failed", r.fields["reason"])
	}
}

func TestWorktreeDiffLogs_NoSourceBranch(t *testing.T) {
	records, cleanup := logCapture(t)
	defer cleanup()

	regDir := t.TempDir()
	wtPath := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: wtPath, RepoPath: "/repo", BranchName: "wt/x"},
	})
	c := NewCheckerAt(regDir)
	c.Diff(context.Background(), DiffRequest{Cwd: wtPath})

	recs := records()
	r := findLog(recs, "worktree diff rejected")
	if r == nil {
		t.Fatal("must log rejection for no source branch")
	}
	if r.fields["reason"] != "no_source_branch" {
		t.Errorf("reason = %v, want no_source_branch", r.fields["reason"])
	}
}

func TestWorktreeDiffLogs_CumulativeSuccess(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)
	records, cleanup := logCapture(t)
	defer cleanup()

	checker.Diff(context.Background(), DiffRequest{Cwd: wtA, Worktree: "wt/a"})

	recs := records()
	if r := findLog(recs, "worktree diff start"); r == nil {
		t.Error("must log start")
	}
	r := findLog(recs, "worktree diff cumulative success")
	if r == nil {
		t.Fatal("must log cumulative success")
	}
	if r.fields["patch_bytes"] == nil {
		t.Error("success log must include patch_bytes")
	}
}
