package gitcontext

import (
	"os"
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
