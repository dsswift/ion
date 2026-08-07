package workspaces

// WorktreeCommits: "what has this worktree's branch actually committed".
//
// See worktree_query.go for the package-level rationale and the safety
// property (every git call runs in the CALLER's own directory, never the
// target worktree's).

import (
	"context"
	"strconv"

	"github.com/dsswift/ion/engine/internal/utils"
)

// CommitEntry is one commit on the resolved branch.
type CommitEntry struct {
	Sha      string `json:"sha"`
	ShortSha string `json:"shortSha"`
	Author   string `json:"author"`
	Date     string `json:"date"`
	Subject  string `json:"subject"`
}

// CommitsRequest asks for the commit log of one worktree's branch.
type CommitsRequest struct {
	// Cwd is the CALLING conversation's own directory; every git invocation
	// runs here, never at Worktree's path.
	Cwd string
	// Worktree names the target by branch name or worktree path. Empty
	// resolves to the caller's own entry.
	Worktree string
	// Limit caps the number of commits returned. Zero means the default (20);
	// clamped to MaxWorktreeCommitsLimit.
	Limit int
	// Path scopes the log to one file or directory, when non-empty.
	Path string
}

// DefaultWorktreeCommitsLimit and MaxWorktreeCommitsLimit bound how many
// commits a single call returns. A busy branch accumulates commits
// indefinitely, and an agent asking "what did this worktree do" wants the
// recent history, not the archive.
const (
	DefaultWorktreeCommitsLimit = 20
	MaxWorktreeCommitsLimit     = 100
)

// CommitsResult is the complete answer. Never an error: every failure is
// expressed via Rejection so a consumer gets an actionable message instead of
// a stack trace.
type CommitsResult struct {
	WorktreePath       string        `json:"worktreePath,omitempty"`
	BranchName         string        `json:"branchName,omitempty"`
	SourceBranch       string        `json:"sourceBranch,omitempty"`
	Path               string        `json:"path,omitempty"`
	Commits            []CommitEntry `json:"commits"`
	UnlandedCount      int           `json:"unlandedCount,omitempty"`
	UnlandedCountKnown bool          `json:"unlandedCountKnown,omitempty"`
	Rejection          string        `json:"rejection,omitempty"`
}

// Commits answers "what has req.Worktree's branch committed", reading
// through the shared object store from req.Cwd.
func (c *Checker) Commits(ctx context.Context, req CommitsRequest) CommitsResult {
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree commits start", map[string]any{
		"cwd": req.Cwd, "worktree": req.Worktree, "limit": req.Limit, "path": req.Path,
	})
	res := CommitsResult{Path: req.Path}
	if c == nil {
		res.Rejection = "workspace containment is disabled, so there is no worktree registry to query"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree commits rejected", map[string]any{
			"cwd": req.Cwd, "reason": "nil_checker",
		})
		return res
	}
	entry, _, rejection := c.resolveWorktreeTarget(req.Cwd, req.Worktree)
	if rejection != "" {
		res.Rejection = rejection
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree commits rejected", map[string]any{
			"cwd": req.Cwd, "worktree": req.Worktree, "reason": "resolve_failed",
		})
		return res
	}
	res.WorktreePath = entry.WorktreePath
	res.BranchName = entry.BranchName
	res.SourceBranch = entry.SourceBranch

	if entry.BranchName == "" {
		res.Rejection = "the worktree " + entry.WorktreePath + " carries no recorded branch name, so its commit log cannot be resolved"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree commits rejected", map[string]any{
			"cwd": req.Cwd, "worktree_path": entry.WorktreePath, "reason": "no_branch_name",
		})
		return res
	}

	limit := req.Limit
	if limit <= 0 {
		limit = DefaultWorktreeCommitsLimit
	}
	if limit > MaxWorktreeCommitsLimit {
		limit = MaxWorktreeCommitsLimit
	}

	args := []string{"log", entry.BranchName, "-n", strconv.Itoa(limit), "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s"}
	if req.Path != "" {
		args = append(args, "--", req.Path)
	}
	out, err := c.gitCtx(ctx, req.Cwd, args...)
	if err != nil {
		res.Rejection = "could not read the commit log for " + entry.BranchName + ": " + err.Error()
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree commits git log failed", map[string]any{
			"cwd": req.Cwd, "branch": entry.BranchName, "error": err.Error(),
		})
		return res
	}
	for _, line := range splitLinesNonEmpty(out) {
		fields := splitOn(line, '\x1f')
		if len(fields) < 5 {
			continue
		}
		res.Commits = append(res.Commits, CommitEntry{
			Sha: fields[0], ShortSha: fields[1], Author: fields[2], Date: fields[3], Subject: fields[4],
		})
	}

	if n, ok := c.unlandedCount(ctx, req.Cwd, entry.SourceBranch, entry.BranchName); ok {
		res.UnlandedCount, res.UnlandedCountKnown = n, true
	}
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree commits success", map[string]any{
		"cwd": req.Cwd, "branch": entry.BranchName, "commit_count": len(res.Commits),
	})
	return res
}

func splitLinesNonEmpty(s string) []string {
	var out []string
	for _, line := range splitOn(trimNewline(s), '\n') {
		if line != "" {
			out = append(out, line)
		}
	}
	return out
}
