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

// runGit executes a read-only git query in cwd.
//
// Every call is prefixed with --no-optional-locks. Without it, `git status`
// opportunistically refreshes the on-disk index, and that refresh takes
// .git/index.lock. This function runs on every prompt dispatch (see
// session.injectGitContext), so in a repo the operator is actively working in
// it collides with whatever git command they are running: an interactive
// rebase, an amend, or a squash fails with
// "Unable to create '.git/index.lock': File exists" because a prompt landed at
// the wrong moment. The engine only ever reads here, so the index refresh is
// pure overhead — dropping the lock removes the race without changing output.
//
// The flag suppresses only *optional* locks; commands that genuinely must lock
// still do. GIT_OPTIONAL_LOCKS=0 is the environment equivalent.
func runGit(cwd string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.Dir = cwd
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
