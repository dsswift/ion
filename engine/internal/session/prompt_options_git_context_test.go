package session

import (
	"os/exec"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestInjectGitContext_StaysOutOfSystemPrompt is the regression test for the
// prompt-cache defect.
//
// The engine injects repository context (branch, short status, recent commits)
// on every prompt. That text used to be appended to opts.AppendSystemPrompt,
// which lands in the system prompt — the head of the provider's cacheable
// prefix. A prompt cache is a prefix match, so volatile bytes inside the prefix
// invalidate everything behind them: the whole system prompt AND the entire
// conversation history. Measured on a real conversation, a ~100-token git block
// forced 11.27M tokens to be re-written at cache-creation rates across 33 turns
// because the operator committed between prompts.
//
// This test fails on the unfixed code: AppendSystemPrompt would contain
// "# Git Context" and GitContextText would be empty.
func TestInjectGitContext_StaysOutOfSystemPrompt(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	cwd := t.TempDir()
	runGit(t, cwd, "init")
	runGit(t, cwd, "commit", "--allow-empty", "-m", "initial commit")

	s := &engineSession{}
	s.config.WorkingDirectory = cwd

	var opts types.RunOptions
	injectGitContext(s, &opts)

	if opts.GitContextText == "" {
		t.Fatal("git context was not resolved into GitContextText")
	}
	if !strings.Contains(opts.GitContextText, "# Git Context") {
		t.Errorf("GitContextText missing header: %q", opts.GitContextText)
	}
	// The invariant that protects the cache.
	if strings.Contains(opts.AppendSystemPrompt, "# Git Context") {
		t.Error("git context leaked into AppendSystemPrompt — this invalidates the cached prefix on every commit")
	}
	if opts.AppendSystemPrompt != "" {
		t.Errorf("AppendSystemPrompt must be untouched by git injection, got %q", opts.AppendSystemPrompt)
	}
}

// TestInjectGitContext_NonRepoLeavesOptionsClean verifies a working directory
// that is not a repository produces no injection at all, rather than an empty
// block that would still occupy the prompt.
func TestInjectGitContext_NonRepoLeavesOptionsClean(t *testing.T) {
	s := &engineSession{}
	s.config.WorkingDirectory = t.TempDir()

	var opts types.RunOptions
	injectGitContext(s, &opts)

	if opts.GitContextText != "" {
		t.Errorf("expected no git context outside a repository, got %q", opts.GitContextText)
	}
	if opts.AppendSystemPrompt != "" {
		t.Errorf("expected untouched AppendSystemPrompt, got %q", opts.AppendSystemPrompt)
	}
}

// TestInjectGitContext_NoWorkingDirectory verifies the empty-cwd guard.
func TestInjectGitContext_NoWorkingDirectory(t *testing.T) {
	s := &engineSession{}

	var opts types.RunOptions
	injectGitContext(s, &opts)

	if opts.GitContextText != "" {
		t.Errorf("expected no git context without a working directory, got %q", opts.GitContextText)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(cmd.Environ(),
		"GIT_AUTHOR_NAME=test",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=test",
		"GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}
