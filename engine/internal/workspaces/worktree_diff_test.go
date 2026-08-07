package workspaces

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorktreeDiff_CommitModeReadsSiblingWithoutVisitingItsDirectory(t *testing.T) {
	checker, _, wtA, wtB := multiWorktreeFixture(t)

	// Resolve wt/b's HEAD sha from wtA's own cwd (shared object store), then
	// show that exact commit -- again from wtA's cwd, never wtB's (which no
	// longer exists on disk).
	res := checker.Commits(context.Background(), CommitsRequest{Cwd: wtA, Worktree: "wt/b"})
	if res.Rejection != "" || len(res.Commits) == 0 {
		t.Fatalf("setup: could not read wt/b's commits: %+v", res)
	}
	bSha := res.Commits[0].Sha

	diff := checker.Diff(context.Background(), DiffRequest{Cwd: wtA, Commit: bSha})
	if diff.Rejection != "" {
		t.Fatalf("commit-mode diff on a sibling's removed-directory commit must still work: %s", diff.Rejection)
	}
	if diff.Mode != "commit" || diff.Commit != bSha {
		t.Errorf("mode/commit = %q/%q, want commit/%q", diff.Mode, diff.Commit, bSha)
	}
	if !strings.Contains(diff.Patch, "feature-b.txt") {
		t.Errorf("patch must show the file the commit touched, got: %s", diff.Patch)
	}
	if diff.Stat == "" {
		t.Error("stat summary must be populated")
	}
	_ = wtB
}

func TestWorktreeDiff_CumulativeModeDefaultsToSourceBranch(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	res := checker.Diff(context.Background(), DiffRequest{Cwd: wtA})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if res.Mode != "cumulative" || res.Against != "main" {
		t.Errorf("mode/against = %q/%q, want cumulative/main", res.Mode, res.Against)
	}
	for _, want := range []string{"feature-a-1.txt", "feature-a-2.txt"} {
		if !strings.Contains(res.Patch, want) {
			t.Errorf("cumulative diff must include %q, got: %s", want, res.Patch)
		}
	}
}

func TestWorktreeDiff_ExplicitAgainstOverridesSourceBranch(t *testing.T) {
	checker, _, wtA, _ := multiWorktreeFixture(t)

	// Diff wt/a against wt/b instead of main.
	res := checker.Diff(context.Background(), DiffRequest{Cwd: wtA, Against: "wt/b"})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if res.Against != "wt/b" {
		t.Errorf("against = %q, want wt/b (explicit override)", res.Against)
	}
}

func TestWorktreeDiff_TruncatesLargePatchButKeepsStat(t *testing.T) {
	checker, repo, wtA, _ := multiWorktreeFixture(t)

	// Grow a file well past MaxWorktreeDiffBytes and commit it on wt/a.
	big := strings.Repeat("line of content that pads the diff out\n", 20000)
	if err := os.WriteFile(filepath.Join(wtA, "big.txt"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, wtA, "add", "-A")
	gitRunIn(t, wtA, "commit", "-m", "wt/a big commit")

	res := checker.Diff(context.Background(), DiffRequest{Cwd: wtA})
	if res.Rejection != "" {
		t.Fatalf("unexpected rejection: %s", res.Rejection)
	}
	if !res.Truncated {
		t.Fatal("a patch exceeding MaxWorktreeDiffBytes must be reported as truncated")
	}
	if len(res.Patch) != MaxWorktreeDiffBytes {
		t.Errorf("truncated patch length = %d, want exactly %d", len(res.Patch), MaxWorktreeDiffBytes)
	}
	if res.Stat == "" {
		t.Error("the stat summary must survive even when the patch is truncated")
	}
	_ = repo
}

func TestWorktreeDiff_NoSourceBranchAndNoAgainstIsRejected(t *testing.T) {
	_, repo, wtA, _ := multiWorktreeFixture(t)

	// A worktree registered with no SourceBranch has nothing to diff against
	// by default.
	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: wtA, RepoPath: repo, BranchName: "wt/a"},
	})
	bare := NewCheckerAt(regDir)

	res := bare.Diff(context.Background(), DiffRequest{Cwd: wtA})
	if res.Rejection == "" {
		t.Fatal("cumulative mode with no source branch and no explicit against must be rejected")
	}
}
