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
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
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
// wtB is also marked landed, matching the terminal worktree whose checkout was
// manually removed in the reported regression.
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
		{WorktreePath: wtB, RepoPath: repo, BranchName: "wt/b", SourceBranch: "main", Title: "worktree B", LandedAt: 1700000500000},
	})
	checker = NewCheckerAt(regDir)
	return checker, repo, wtA, wtB
}

// TestRunGitCtx_CancelledGitDescendantDoesNotHoldQueryOpen simulates a git
// executable that leaves a descendant holding stdout open after the parent is
// cancelled. WaitDelay must force the pipe closed so the query returns promptly.
func TestRunGitCtx_CancelledGitDescendantDoesNotHoldQueryOpen(t *testing.T) {
	binDir := t.TempDir()
	gitPath := filepath.Join(binDir, "git")
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	t.Setenv("ION_TEST_DESCENDANT_PID", pidFile)
	script := "#!/bin/sh\nsleep 30 &\npid_tmp=\"$ION_TEST_DESCENDANT_PID.tmp\"\necho $! > \"$pid_tmp\"\nmv \"$pid_tmp\" \"$ION_TEST_DESCENDANT_PID\"\nsleep 30\n"
	if err := os.WriteFile(gitPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := runGitCtx(ctx, t.TempDir(), "log", "-1")
		result <- err
	}()

	var pid int
	deadline := time.After(time.Second)
	for pid == 0 {
		pidBytes, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			parsed, parseErr := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			if parseErr != nil {
				t.Fatalf("parse descendant pid %q: %v", pidBytes, parseErr)
			}
			pid = parsed
			break
		}
		if !os.IsNotExist(readErr) {
			t.Fatalf("read descendant pid: %v", readErr)
		}
		select {
		case <-deadline:
			t.Fatal("git shim never started its pipe-owning descendant")
		case <-time.After(time.Millisecond):
		}
	}
	defer func() {
		if killErr := syscall.Kill(pid, syscall.SIGKILL); killErr != nil && killErr != syscall.ESRCH {
			t.Fatalf("cleanup descendant process: %v", killErr)
		}
	}()

	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("runGitCtx succeeded after context cancellation")
		}
	case <-time.After(2 * gitQueryWaitDelay):
		t.Fatalf("runGitCtx exceeded %s after its descendant inherited stdout", 2*gitQueryWaitDelay)
	}
	if elapsed := time.Since(started); elapsed > 2*gitQueryWaitDelay+time.Second {
		t.Fatalf("runGitCtx returned after %s, want descendant pipe cleanup bounded by WaitDelay", elapsed)
	}
}
