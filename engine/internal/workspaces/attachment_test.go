package workspaces

// Attachment inspection against REAL git repositories.
//
// The behavior under test IS git's on-disk state layout — a linked worktree
// whose rebase state lives under `.git/worktrees/<id>/rebase-merge/`, reached
// only via `rev-parse --git-path`. A mock would restate the layout this code
// exists to read correctly, and would have happily passed the naive
// `.git/rebase-merge` join that misses every marker in a linked worktree.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitRunIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Dev", "GIT_AUTHOR_EMAIL=dev@example.com",
		"GIT_COMMITTER_NAME=Dev", "GIT_COMMITTER_EMAIL=dev@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

// attachmentFixture builds a real repo plus a linked worktree on `wt/feature`,
// registers it, and returns the checker and the worktree path.
func attachmentFixture(t *testing.T) (*Checker, string) {
	t.Helper()
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}

	gitRunIn(t, repo, "init", "-b", "main")
	gitRunIn(t, repo, "config", "user.email", "dev@example.com")
	gitRunIn(t, repo, "config", "user.name", "Dev")
	gitRunIn(t, repo, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("line1\nline2\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, repo, "add", "-A")
	gitRunIn(t, repo, "commit", "-m", "base")

	worktree := filepath.Join(root, "wt-feature")
	gitRunIn(t, repo, "worktree", "add", "-b", "wt/feature", worktree, "main")

	regDir := t.TempDir()
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: worktree, RepoPath: repo, BranchName: "wt/feature"},
	})
	return NewCheckerAt(regDir), worktree
}

// strandMidRebase drives the worktree into the exact state from the incident:
// a rebase stopped on a conflict, HEAD detached at the transient position.
func strandMidRebase(t *testing.T, repo, worktree string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(worktree, "shared.txt"), []byte("line1\nWORKTREE\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, worktree, "add", "-A")
	gitRunIn(t, worktree, "commit", "-m", "worktree edit")

	if err := os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("line1\nMAIN\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, repo, "add", "-A")
	gitRunIn(t, repo, "commit", "-m", "main edit")

	// Expected to fail: the conflict is the point.
	cmd := exec.Command("git", "rebase", "main")
	cmd.Dir = worktree
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("rebase unexpectedly succeeded; the fixture needs a real conflict:\n%s", out)
	}
}

func TestInspectAttachment_HealthyWorktreeReportsNothing(t *testing.T) {
	checker, worktree := attachmentFixture(t)

	if att := checker.InspectAttachment(worktree); att != nil {
		t.Fatalf("a worktree on its branch with no operation must report nothing, got %+v", att)
	}
}

// The incident, pinned. RED before the fix: nothing inspected HEAD after a
// Bash call, so a conflicted rebase left the worktree detached unnoticed.
func TestInspectAttachment_ConflictedRebaseIsReported(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	repo := filepath.Join(filepath.Dir(worktree), "repo")
	strandMidRebase(t, repo, worktree)

	att := checker.InspectAttachment(worktree)
	if att == nil {
		t.Fatal("a conflicted rebase leaving HEAD detached must be reported")
	}
	if !att.Detached {
		t.Error("expected Detached=true mid-rebase")
	}
	if att.Operation != "rebase" {
		t.Errorf("Operation = %q, want rebase", att.Operation)
	}
	// The branch git recorded in rebase-merge/head-name — reached only through
	// --git-path, since a linked worktree's state is under the common dir.
	if att.RecordedBranch != "wt/feature" {
		t.Errorf("RecordedBranch = %q, want wt/feature (head-name not read via --git-path?)", att.RecordedBranch)
	}
	if att.ExpectedBranch != "wt/feature" {
		t.Errorf("ExpectedBranch = %q, want the registry's branch", att.ExpectedBranch)
	}

	notice := att.Notice()
	for _, want := range []string{"wt/feature", "rebase --continue", "rebase --abort", worktree} {
		if !strings.Contains(notice, want) {
			t.Errorf("notice must contain %q so the model can act on it, got: %s", want, notice)
		}
	}
}

// Resolving the conflict and finishing the rebase clears the report — the
// notice must not persist once the worktree is healthy again.
func TestInspectAttachment_ClearsAfterRebaseCompletes(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	repo := filepath.Join(filepath.Dir(worktree), "repo")
	strandMidRebase(t, repo, worktree)

	if err := os.WriteFile(filepath.Join(worktree, "shared.txt"), []byte("line1\nRESOLVED\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, worktree, "add", "-A")
	cmd := exec.Command("git", "-c", "core.editor=true", "rebase", "--continue")
	cmd.Dir = worktree
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Dev", "GIT_AUTHOR_EMAIL=dev@example.com",
		"GIT_COMMITTER_NAME=Dev", "GIT_COMMITTER_EMAIL=dev@example.com",
		"GIT_EDITOR=true",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rebase --continue: %v\n%s", err, out)
	}

	if att := checker.InspectAttachment(worktree); att != nil {
		t.Fatalf("a completed rebase must clear the report, got %+v", att)
	}
}

// Aborting is the other resolution path and must equally clear the report.
func TestInspectAttachment_ClearsAfterRebaseAborts(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	repo := filepath.Join(filepath.Dir(worktree), "repo")
	strandMidRebase(t, repo, worktree)

	gitRunIn(t, worktree, "rebase", "--abort")

	if att := checker.InspectAttachment(worktree); att != nil {
		t.Fatalf("an aborted rebase must clear the report, got %+v", att)
	}
}

// A plain detach with no operation running: the notice names the re-attach
// command, and offers checkout -B so commits made while detached survive.
func TestInspectAttachment_PlainDetachReportsReattach(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	gitRunIn(t, worktree, "checkout", "--detach", "HEAD")

	att := checker.InspectAttachment(worktree)
	if att == nil {
		t.Fatal("a detached HEAD must be reported")
	}
	if !att.Detached || att.Operation != "" {
		t.Fatalf("want plain detach with no operation, got %+v", att)
	}

	notice := att.Notice()
	for _, want := range []string{"git checkout wt/feature", "checkout -B wt/feature"} {
		if !strings.Contains(notice, want) {
			t.Errorf("notice must offer %q, got: %s", want, notice)
		}
	}
}

// A conflicted merge is a different operation with the same shape: HEAD stays
// attached, but the worktree must not be left mid-merge.
func TestInspectAttachment_ConflictedMergeReportedWhileAttached(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	repo := filepath.Join(filepath.Dir(worktree), "repo")

	if err := os.WriteFile(filepath.Join(worktree, "shared.txt"), []byte("line1\nWORKTREE\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, worktree, "add", "-A")
	gitRunIn(t, worktree, "commit", "-m", "worktree edit")

	if err := os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("line1\nMAIN\nline3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitRunIn(t, repo, "add", "-A")
	gitRunIn(t, repo, "commit", "-m", "main edit")

	cmd := exec.Command("git", "merge", "main")
	cmd.Dir = worktree
	if out, err := cmd.CombinedOutput(); err == nil {
		t.Fatalf("merge unexpectedly clean; fixture needs a conflict:\n%s", out)
	}

	att := checker.InspectAttachment(worktree)
	if att == nil {
		t.Fatal("an interrupted merge must be reported")
	}
	if att.Detached {
		t.Error("a conflicted merge keeps HEAD attached; Detached must be false")
	}
	if att.Operation != "merge" {
		t.Errorf("Operation = %q, want merge", att.Operation)
	}
	if !strings.Contains(att.Notice(), "merge --continue") {
		t.Errorf("notice must name the merge resolution commands, got: %s", att.Notice())
	}
}

// Not a worktree conversation: an ordinary clone is never inspected, so the
// check cannot produce noise outside the workspaces it governs.
func TestInspectAttachment_UnregisteredDirectoryReportsNothing(t *testing.T) {
	checker, worktree := attachmentFixture(t)
	repo := filepath.Join(filepath.Dir(worktree), "repo")

	if att := checker.InspectAttachment(repo); att != nil {
		t.Fatalf("the base repo is not a registered worktree; got %+v", att)
	}
	if att := checker.InspectAttachment(t.TempDir()); att != nil {
		t.Fatalf("an unrelated directory must report nothing, got %+v", att)
	}
}

// Fail open: an unreadable git state yields no report rather than a false
// alarm, matching the posture of the rest of the package.
func TestInspectAttachment_FailsOpenOnUnreadableGitState(t *testing.T) {
	regDir := t.TempDir()
	missing := filepath.Join(t.TempDir(), "not-a-repo")
	writeWorktreeRegistry(t, regDir, []WorktreeEntry{
		{WorktreePath: missing, RepoPath: "/repo", BranchName: "wt/gone"},
	})
	checker := NewCheckerAt(regDir)

	if att := checker.InspectAttachment(missing); att != nil {
		t.Fatalf("an unreadable worktree must fail open, got %+v", att)
	}
}
