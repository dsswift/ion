// Package gitcontext extracts git repository context for system prompt injection.
package gitcontext

import (
	"os/exec"
	"strings"
)

// GitContext holds repository context.
type GitContext struct {
	IsRepo        bool   `json:"isRepo"`
	Branch        string `json:"branch,omitempty"`
	MainBranch    string `json:"mainBranch,omitempty"`
	Status        string `json:"status,omitempty"`
	RecentCommits string `json:"recentCommits,omitempty"`
	UserName      string `json:"userName,omitempty"`
	UserEmail     string `json:"userEmail,omitempty"`
}

const maxStatusBytes = 2048

// GetGitContext extracts git context from the given working directory.
// Returns nil if not a git repo or git not available.
func GetGitContext(cwd string) *GitContext {
	if cwd == "" {
		return nil
	}

	// Check if git repo
	if _, err := runGit(cwd, "rev-parse", "--is-inside-work-tree"); err != nil {
		return nil
	}

	ctx := &GitContext{IsRepo: true}

	// Branch
	if out, err := runGit(cwd, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		ctx.Branch = strings.TrimSpace(out)
	}

	// Main branch detection
	ctx.MainBranch = detectMainBranch(cwd)

	// Status (short, truncate at 2KB)
	if out, err := runGit(cwd, "status", "--short"); err == nil {
		s := strings.TrimSpace(out)
		if len(s) > maxStatusBytes {
			s = s[:maxStatusBytes] + "\n...(truncated)"
		}
		ctx.Status = s
	}

	// Recent commits (last 5)
	if out, err := runGit(cwd, "log", "--oneline", "-5"); err == nil {
		ctx.RecentCommits = strings.TrimSpace(out)
	}

	// User name
	if out, err := runGit(cwd, "config", "user.name"); err == nil {
		ctx.UserName = strings.TrimSpace(out)
	}

	// User email
	if out, err := runGit(cwd, "config", "user.email"); err == nil {
		ctx.UserEmail = strings.TrimSpace(out)
	}

	return ctx
}

func detectMainBranch(cwd string) string {
	for _, name := range []string{"main", "master"} {
		if _, err := runGit(cwd, "rev-parse", "--verify", name); err == nil {
			return name
		}
	}
	return "main"
}

// FormatForPrompt returns a formatted string suitable for system prompt injection.
func FormatForPrompt(ctx *GitContext) string {
	if ctx == nil {
		return ""
	}

	var parts []string
	if ctx.Branch != "" {
		parts = append(parts, "Branch: "+ctx.Branch)
	}
	if ctx.UserName != "" {
		parts = append(parts, "User: "+ctx.UserName)
	}
	if ctx.Status != "" {
		lines := strings.Split(ctx.Status, "\n")
		if len(lines) > 10 {
			lines = lines[:10]
			lines = append(lines, "... (truncated)")
		}
		parts = append(parts, "Status:\n"+strings.Join(lines, "\n"))
	}
	if ctx.RecentCommits != "" {
		parts = append(parts, "Recent commits:\n"+ctx.RecentCommits)
	}

	if len(parts) == 0 {
		return ""
	}
	return "# Git Context\n" + strings.Join(parts, "\n")
}

func runGit(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
