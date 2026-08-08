package backend

// Run-loop wiring for the worktree attachment check — the post-execution half
// of worktree containment.
//
// internal/workspaces pins the inspection itself against real git state. What
// these pin is the wiring decision made in the tool loop: a Bash command that
// leaves the worktree detached or mid-operation gets the warning appended to
// the result the model reads next, the result is NOT flipped to an error (the
// command usually succeeded, and a mid-rebase pause is a legitimate step of the
// operator's amend sequence), and a healthy worktree gets nothing appended.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

func attachGit(t *testing.T, dir string, args ...string) {
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

// attachmentRunFixture returns a checker plus a real registered worktree on
// branch `wt/feature`.
func attachmentRunFixture(t *testing.T) (*workspaces.Checker, string) {
	t.Helper()
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	attachGit(t, repo, "init", "-b", "main")
	attachGit(t, repo, "config", "user.email", "dev@example.com")
	attachGit(t, repo, "config", "user.name", "Dev")
	attachGit(t, repo, "config", "commit.gpgsign", "false")
	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	attachGit(t, repo, "add", "-A")
	attachGit(t, repo, "commit", "-m", "base")

	worktree := filepath.Join(root, "wt-feature")
	attachGit(t, repo, "worktree", "add", "-b", "wt/feature", worktree, "main")

	regDir := t.TempDir()
	payload := map[string]any{"version": 1, "entries": []map[string]any{
		{"worktreePath": worktree, "repoPath": repo, "branchName": "wt/feature"},
	}}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(regDir, "worktree-registry.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	return workspaces.NewCheckerAt(regDir), worktree
}

// primeRebaseConflict lands divergent edits on main and the worktree branch so
// that `git rebase main` inside the worktree stops on a conflict — the exact
// shape of the incident: an ALLOWED command that detaches HEAD.
func primeRebaseConflict(t *testing.T, worktree string) {
	t.Helper()
	repo := filepath.Join(filepath.Dir(worktree), "repo")

	if err := os.WriteFile(filepath.Join(worktree, "f.txt"), []byte("worktree\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	attachGit(t, worktree, "add", "-A")
	attachGit(t, worktree, "commit", "-m", "worktree edit")

	if err := os.WriteFile(filepath.Join(repo, "f.txt"), []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	attachGit(t, repo, "add", "-A")
	attachGit(t, repo, "commit", "-m", "main edit")
}

func runBash(t *testing.T, checker *workspaces.Checker, cwd, command string) []conversation.ToolResultEntry {
	t.Helper()
	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "attach-req",
		conv:      &conversation.Conversation{ID: "conv-attach"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}, WorkspaceChecker: checker},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Bash",
		ID:    "tc-attach",
		Input: map[string]interface{}{"command": command},
	}}
	results, err := b.executeTools(context.Background(), run, blocks, cwd)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result, got %d", len(results))
	}
	return results
}

// The incident, at the run-loop seam: a Bash command that detaches HEAD comes
// back with the warning attached. RED before the fix — nothing inspected the
// worktree after execution, so the result was silent about the detach.
func TestExecuteTools_DetachedHeadWarningAppendedToBashResult(t *testing.T) {
	checker, worktree := attachmentRunFixture(t)
	primeRebaseConflict(t, worktree)

	// `git rebase` is ALLOWED — /align's amend sequence depends on it. The
	// conflict stops it mid-flight with HEAD detached, which is the state the
	// check exists to surface.
	results := runBash(t, checker, worktree, "git rebase main")

	if !strings.Contains(results[0].Content, "[worktree attachment]") {
		t.Fatalf("a Bash command that detached HEAD must append the attachment warning, got: %s", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "wt/feature") {
		t.Errorf("warning must name the branch to return to, got: %s", results[0].Content)
	}
	if !strings.Contains(results[0].Content, "rebase --continue") {
		t.Errorf("warning must name the commands that resolve it, got: %s", results[0].Content)
	}
}

// The warning is advisory: the command succeeded, so the result must not be
// flipped to an error. Marking it IsError would make the model treat a
// legitimate mid-amend step as a failed command and start retrying it.
func TestExecuteTools_AttachmentWarningDoesNotErrorTheResult(t *testing.T) {
	checker, worktree := attachmentRunFixture(t)
	primeRebaseConflict(t, worktree)

	// A conflicted rebase exits non-zero, so the Bash result is legitimately
	// an error already. Use the resolved-and-continued case: the command
	// succeeds, HEAD is still detached mid-rebase, and the warning must ride
	// along without turning a successful command into a failure.
	runBash(t, checker, worktree, "git rebase main")
	results := runBash(t, checker, worktree, "git status --short")

	if results[0].IsError {
		t.Error("the attachment warning is advisory; a succeeding command must not be reported as an error")
	}
	if !strings.Contains(results[0].Content, "[worktree attachment]") {
		t.Errorf("the warning must still be present on the successful command, got: %s", results[0].Content)
	}
}

// A healthy worktree gets nothing appended — the check must not add noise to
// every Bash result in every worktree conversation.
func TestExecuteTools_NoAttachmentWarningWhenWorktreeHealthy(t *testing.T) {
	checker, worktree := attachmentRunFixture(t)

	results := runBash(t, checker, worktree, "git status --short")

	if strings.Contains(results[0].Content, "[worktree attachment]") {
		t.Fatalf("a healthy worktree must produce no warning, got: %s", results[0].Content)
	}
}

// Non-Bash tools skip the check entirely: a Write cannot move HEAD, and paying
// two git subprocesses per file edit would be pure overhead.
func TestExecuteTools_AttachmentCheckSkippedForNonBashTools(t *testing.T) {
	checker, worktree := attachmentRunFixture(t)
	attachGit(t, worktree, "checkout", "--detach", "HEAD")

	b := NewApiBackend()
	b.OnNormalized(func(_ string, _ types.NormalizedEvent) {})
	run := &activeRun{
		requestID: "attach-write",
		conv:      &conversation.Conversation{ID: "conv-attach-write"},
		cfg:       &RunConfig{Telemetry: &mockTelemetry{}, WorkspaceChecker: checker},
	}
	blocks := []types.LlmContentBlock{{
		Name:  "Write",
		ID:    "tc-attach-write",
		Input: map[string]interface{}{"file_path": filepath.Join(worktree, "n.txt"), "content": "x"},
	}}

	results, err := b.executeTools(context.Background(), run, blocks, worktree)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(results[0].Content, "[worktree attachment]") {
		t.Errorf("Write must not trigger the attachment check, got: %s", results[0].Content)
	}
}

// Disabled containment threads a nil checker; the attachment check must be
// nil-safe on that path rather than panicking the run.
func TestExecuteTools_AttachmentCheckNilSafeWhenContainmentDisabled(t *testing.T) {
	_, worktree := attachmentRunFixture(t)
	attachGit(t, worktree, "checkout", "--detach", "HEAD")

	results := runBash(t, nil, worktree, "git status --short")

	if strings.Contains(results[0].Content, "[worktree attachment]") {
		t.Error("a nil checker must produce no warning")
	}
}
