package workspaces

// Shared fixture for the cross-worktree query tests (WorktreeList,
// WorktreeCommits, WorktreeDiff): a real repo with two linked worktrees on
// separate branches, each with its own commits.
//
// Real git, not mocks — the property under test is the shared object-store
// behavior (a sibling's branch is readable without visiting its directory),
// and a mock would restate that behavior rather than exercise it. Reuses
// gitRunIn from attachment_test.go (same package).

import (
	"os"
	"path/filepath"
	"testing"
)

// multiWorktreeFixture builds:
//   - repo: a bare-bones repo on "main" with one base commit.
//   - wtA:  a linked worktree on "wt/a" with two commits ahead of main.
//   - wtB:  a linked worktree on "wt/b" with one commit ahead of main, whose
//     checkout is then REMOVED (git worktree remove --force) while its
//     branch and commits remain in the shared object store. This is the
//     mechanism that proves cross-worktree reads never visit the sibling's
//     directory: if a query under test ever ran a git command with cwd set
//     to wtB, that command would fail outright (no such directory) once wtB
//     no longer exists on disk.
//
// Both worktrees are registered with RepoPath=repo and SourceBranch="main".
func multiWorktreeFixture(t *testing.T) (checker *Checker, repo, wtA, wtB string) {
	t.Helper()
	root := t.TempDir()
	repo = filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, repo, "init", "-b", "main")
	gitRunIn(t, repo, "config", "user.email", "dev@example.com")
	gitRunIn(t, repo, "config", "user.name", "Dev")
	gitRunIn(t, repo, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, repo, "add", "-A")
	gitRunIn(t, repo, "commit", "-m", "base commit")

	wtA = filepath.Join(root, "wt-a")
	gitRunIn(t, repo, "worktree", "add", "-b", "wt/a", wtA, "main")
	if err := os.WriteFile(filepath.Join(wtA, "feature-a-1.txt"), []byte("a1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, wtA, "add", "-A")
	gitRunIn(t, wtA, "commit", "-m", "wt/a commit 1")
	if err := os.WriteFile(filepath.Join(wtA, "feature-a-2.txt"), []byte("a2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, wtA, "add", "-A")
	gitRunIn(t, wtA, "commit", "-m", "wt/a commit 2")

	wtB = filepath.Join(root, "wt-b")
	gitRunIn(t, repo, "worktree", "add", "-b", "wt/b", wtB, "main")
	if err := os.WriteFile(filepath.Join(wtB, "feature-b.txt"), []byte("b1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, wtB, "add", "-A")
	gitRunIn(t, wtB, "commit", "-m", "wt/b commit 1")

	// Remove wtB's checkout so its directory genuinely does not exist. The
	// branch and its commits remain reachable through the shared object
	// store from any other worktree of the same repo.
	gitRunIn(t, repo, "worktree", "remove", "--force", wtB)
	if _, err := os.Stat(wtB); err == nil {
		t.Fatalf("wtB %s must not exist on disk after removal", wtB)
	}

	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: wtA, RepoPath: repo, BranchName: "wt/a", SourceBranch: "main", Title: "worktree A"},
		{WorktreePath: wtB, RepoPath: repo, BranchName: "wt/b", SourceBranch: "main", Title: "worktree B"},
	})
	return NewCheckerAt(regDir), repo, wtA, wtB
}
