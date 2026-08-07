package workspaces

import (
	"context"
	"strings"
	"testing"
)

func TestWorktreeCommits_ReadsSiblingBranchWithoutVisitingItsDirectory(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	// wtB's directory no longer exists (removed by the fixture). If Commits
	// ever ran git with cwd=wtB, this call would fail outright. Reading it
	// from wtA's cwd must still succeed via the shared object store.
	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Worktree: "wt/b"})
	if res.Rejection != "" {
		t.Fatalf("reading a sibling's removed-directory branch must still work via the shared object store: %s", res.Rejection)
	}
	// `git log` on a branch shows its full history: wt/b's own commit plus
	// the base commit it branched from.
	if len(res.Commits) != 2 {
		t.Fatalf("wt/b's log is 1 commit ahead of the base commit, want 2 total, got %d: %+v", len(res.Commits), res.Commits)
	}
	if res.Commits[0].Subject != "wt/b commit 1" {
		t.Errorf("subject = %q, want %q", res.Commits[0].Subject, "wt/b commit 1")
	}
	if !res.UnlandedCountKnown || res.UnlandedCount != 1 {
		t.Errorf("unlandedCount = %+v, want known=true count=1", res)
	}
}

func TestWorktreeCommits_DefaultsToCallerOwnBranch(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if res.BranchName != "wt/a" {
		t.Errorf("branch = %q, want wt/a (the caller's own)", res.BranchName)
	}
	// `git log` shows wt/a's full history: 2 commits of its own plus the base
	// commit it branched from.
	if len(res.Commits) != 3 {
		t.Fatalf("wt/a's log = %d commits, want 3 (2 own + base)", len(res.Commits))
	}
	// Newest first.
	if res.Commits[0].Subject != "wt/a commit 2" {
		t.Errorf("commits[0] = %q, want newest first", res.Commits[0].Subject)
	}
}

func TestWorktreeCommits_LimitClampedToMax(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Limit: 100000})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	// Only 3 commits exist on wt/a's full history (2 own + base); the clamp
	// to MaxWorktreeCommitsLimit must not itself cause a rejection or an
	// error, and git must not invent more than actually exist.
	if len(res.Commits) != 3 {
		t.Errorf("commits = %d, want 3 (all available, clamp does not invent more)", len(res.Commits))
	}
}

func TestWorktreeCommits_UnknownWorktreeIsRejectedWithNamedSet(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Worktree: "wt/does-not-exist"})
	if res.Rejection == "" {
		t.Fatal("an unresolvable worktree name must be rejected")
	}
	if !strings.Contains(res.Rejection, "wt/does-not-exist") {
		t.Errorf("rejection must name what was asked for: %s", res.Rejection)
	}
}

func TestWorktreeCommits_PathScopesTheLog(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Path: "feature-a-1.txt"})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if len(res.Commits) != 1 || res.Commits[0].Subject != "wt/a commit 1" {
		t.Fatalf("path-scoped log should show only the commit touching that file, got %+v", res.Commits)
	}
}
