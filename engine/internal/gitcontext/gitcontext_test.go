package gitcontext

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestGetGitContext_EngineRepo(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	ctx := GetGitContext(cwd)
	if ctx == nil {
		t.Fatal("GetGitContext returned nil for engine repo")
	}
	if !ctx.IsRepo {
		t.Error("expected IsRepo to be true")
	}
	if ctx.Branch == "" {
		t.Error("expected Branch to be non-empty")
	}
}

func TestGetGitContext_EmptyCwd(t *testing.T) {
	ctx := GetGitContext("")
	if ctx != nil {
		t.Error("GetGitContext should return nil for empty cwd")
	}
}

func TestGetGitContext_NonGitDir(t *testing.T) {
	ctx := GetGitContext("/tmp")
	if ctx != nil {
		t.Error("GetGitContext should return nil for non-git directory")
	}
}

func TestFormatForPrompt_Nil(t *testing.T) {
	result := FormatForPrompt(nil)
	if result != "" {
		t.Errorf("FormatForPrompt(nil) should return empty string, got: %q", result)
	}
}

func TestFormatForPrompt_Populated(t *testing.T) {
	ctx := &GitContext{
		IsRepo:        true,
		Branch:        "main",
		UserName:      "testuser",
		Status:        "M file.go",
		RecentCommits: "abc1234 some commit",
	}
	result := FormatForPrompt(ctx)
	if !strings.HasPrefix(result, "# Git Context") {
		t.Errorf("FormatForPrompt should start with '# Git Context', got: %q", result)
	}
	if !strings.Contains(result, "Branch: main") {
		t.Error("expected output to contain branch info")
	}
	if !strings.Contains(result, "User: testuser") {
		t.Error("expected output to contain user info")
	}
	if !strings.Contains(result, "M file.go") {
		t.Error("expected output to contain status")
	}
	if !strings.Contains(result, "abc1234 some commit") {
		t.Error("expected output to contain recent commits")
	}
}

func TestDetectMainBranch_EngineRepo(t *testing.T) {
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("os.Getwd: %v", err)
	}
	branch := detectMainBranch(cwd)
	if branch != "main" && branch != "master" {
		t.Errorf("detectMainBranch should return 'main' or 'master', got: %q", branch)
	}
}

// TestRunGit_UsesNoOptionalLocks pins the fix for the index.lock race: every
// git invocation from this package must pass --no-optional-locks so a prompt
// dispatch never contends with the operator's own rebase/amend/squash for
// .git/index.lock.
//
// The assertion is on the argv the package actually executes, captured by a
// `git` shim placed first on PATH. Asserting on behavior instead would be
// unreliable — `git status` degrades gracefully when it cannot take the lock,
// so it succeeds either way and would not distinguish fixed from broken.
func TestRunGit_UsesNoOptionalLocks(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "args.txt")

	shim := filepath.Join(dir, "git")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + argsFile + "\nexit 0\n"
	if err := os.WriteFile(shim, []byte(script), 0o755); err != nil {
		t.Fatalf("write shim: %v", err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if _, err := runGit(dir, "status", "--short"); err != nil {
		t.Fatalf("runGit: %v", err)
	}

	recorded, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read recorded args: %v", err)
	}
	got := strings.Split(strings.TrimSpace(string(recorded)), "\n")
	if len(got) == 0 || got[0] != "--no-optional-locks" {
		t.Errorf("expected --no-optional-locks as the first argument, got %v", got)
	}
	if !slices.Contains(got, "status") {
		t.Errorf("expected the caller's subcommand to survive, got %v", got)
	}
}
