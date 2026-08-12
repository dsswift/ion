// Package gitcontext extracts git repository context for system prompt injection.
package gitcontext

import (
	"context"
	"os/exec"
	"strings"
	"time"
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
	return GetGitContextWithContext(context.Background(), cwd)
}

// GetGitContextWithContext extracts git context, respecting the context
// deadline. Returns nil if the context expires, the directory is not a git
// repo, or git is unavailable.
func GetGitContextWithContext(ctx context.Context, cwd string) *GitContext {
	if cwd == "" {
		return nil
	}

	if _, err := runGitCtx(ctx, cwd, "rev-parse", "--is-inside-work-tree"); err != nil {
		return nil
	}

	gc := &GitContext{IsRepo: true}

	if out, err := runGitCtx(ctx, cwd, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		gc.Branch = strings.TrimSpace(out)
	}

	gc.MainBranch = detectMainBranch(ctx, cwd)

	if out, err := runGitCtx(ctx, cwd, "status", "--short"); err == nil {
		s := strings.TrimSpace(out)
		if len(s) > maxStatusBytes {
			s = s[:maxStatusBytes] + "\n...(truncated)"
		}
		gc.Status = s
	}

	if out, err := runGitCtx(ctx, cwd, "log", "--oneline", "-5"); err == nil {
		gc.RecentCommits = strings.TrimSpace(out)
	}

	return gc
}

func detectMainBranch(ctx context.Context, cwd string) string {
	for _, name := range []string{"main", "master"} {
		if _, err := runGitCtx(ctx, cwd, "rev-parse", "--verify", name); err == nil {
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

// runGitCtx executes a read-only git query in cwd, respecting the context
// deadline.
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
//
// WaitDelay bounds Cmd.Output's wait after the context is cancelled.
// exec.CommandContext alone only signals the DIRECT child; if that child has
// spawned its own subprocess which inherited the stdout/stderr pipes (any
// shell wrapper, a git hook, a credential helper), the direct child can exit
// on cancellation while the grandchild keeps the pipe open — Output() then
// blocks reading from that pipe until the grandchild exits on its own,
// silently defeating the deadline this function exists to enforce. WaitDelay
// gives the direct child a grace window to exit cleanly, then force-closes
// the I/O pipes itself so Output() returns promptly regardless of what any
// descendant process is still doing. Kept short (well under the shortest
// realistic caller deadline, gitContextTimeout in prompt_options.go) so it
// adds negligible latency on the success path.
func runGitCtx(ctx context.Context, cwd string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-optional-locks"}, args...)...)
	cmd.Dir = cwd
	cmd.WaitDelay = 500 * time.Millisecond
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
