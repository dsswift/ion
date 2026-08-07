package workspaces

// WorktreeDiff: "what does this worktree's branch's work actually look
// like" -- one commit, or everything since it diverged from its source.
//
// See worktree_query.go for the package-level rationale and the safety
// property (every git call runs in the CALLER's own directory, never the
// target worktree's).

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// MaxWorktreeDiffBytes caps the returned patch text. Matches the desktop's
// MAX_MEMBER_FILE_BYTES precedent (bench-member-file.ts): large enough for
// the diffs that actually matter, small enough that a stray request against a
// huge branch cannot flood a context window. Exceeding it truncates and says
// so via Truncated, rather than failing -- a truncated head is usually enough
// to decide, and an error would send the agent back to shelling out.
const MaxWorktreeDiffBytes = 256 * 1024

// DiffRequest asks for a diff against one worktree's branch.
type DiffRequest struct {
	// Cwd is the CALLING conversation's own directory; every git invocation
	// runs here, never at Worktree's path.
	Cwd string
	// Worktree names the target by branch name or worktree path. Empty
	// resolves to the caller's own entry.
	Worktree string
	// Commit selects commit mode: show exactly this one commit. Empty
	// selects cumulative mode: everything the branch did since Against.
	Commit string
	// Against is the ref cumulative mode diffs against (three-dot). Empty
	// defaults to the resolved entry's SourceBranch.
	Against string
	// Path scopes the diff to one file or directory, when non-empty.
	Path string
}

// DiffResult is the complete answer. Never an error: every failure is
// expressed via Rejection.
type DiffResult struct {
	WorktreePath string `json:"worktreePath,omitempty"`
	BranchName   string `json:"branchName,omitempty"`
	// Mode is "commit" or "cumulative".
	Mode string `json:"mode,omitempty"`
	// Commit echoes the resolved commit sha in commit mode.
	Commit string `json:"commit,omitempty"`
	// Against echoes the resolved comparison ref in cumulative mode.
	Against string `json:"against,omitempty"`
	Path    string `json:"path,omitempty"`
	// Stat is `git diff/show --stat` output -- a small summary that always
	// survives even when Patch is truncated.
	Stat string `json:"stat,omitempty"`
	// Patch is the full diff text, possibly truncated. Binary content is
	// already rendered by git as "Binary files ... differ" -- no separate
	// detection pass is needed here (unlike bench-member-file.ts, which reads
	// raw file content).
	Patch     string `json:"patch,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
	Rejection string `json:"rejection,omitempty"`
}

// Diff answers a diff request against req.Worktree's branch, reading through
// the shared object store from req.Cwd.
func (c *Checker) Diff(ctx context.Context, req DiffRequest) DiffResult {
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree diff start", map[string]any{
		"cwd": req.Cwd, "worktree": req.Worktree, "commit": req.Commit, "against": req.Against, "path": req.Path,
	})
	res := DiffResult{Path: req.Path}
	if c == nil {
		res.Rejection = "workspace containment is disabled, so there is no worktree registry to query"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree diff rejected", map[string]any{
			"cwd": req.Cwd, "reason": "nil_checker",
		})
		return res
	}
	entry, _, rejection := c.resolveWorktreeTarget(req.Cwd, req.Worktree)
	if rejection != "" {
		res.Rejection = rejection
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree diff rejected", map[string]any{
			"cwd": req.Cwd, "worktree": req.Worktree, "reason": "resolve_failed",
		})
		return res
	}
	res.WorktreePath = entry.WorktreePath
	res.BranchName = entry.BranchName

	if req.Commit != "" {
		c.diffCommit(ctx, req, &res)
		return res
	}
	c.diffCumulative(ctx, req, entry, &res)
	return res
}

func (c *Checker) diffCommit(ctx context.Context, req DiffRequest, res *DiffResult) {
	res.Mode = "commit"
	res.Commit = req.Commit

	statArgs := []string{"show", "--stat", req.Commit}
	if req.Path != "" {
		statArgs = append(statArgs, "--", req.Path)
	}
	if out, err := c.gitCtx(ctx, req.Cwd, statArgs...); err == nil {
		res.Stat = trimNewline(out)
	} else {
		res.Rejection = "could not read commit " + req.Commit + ": " + err.Error()
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree diff commit stat failed", map[string]any{
			"cwd": req.Cwd, "commit": req.Commit, "error": err.Error(),
		})
		return
	}

	patchArgs := []string{"show", req.Commit}
	if req.Path != "" {
		patchArgs = append(patchArgs, "--", req.Path)
	}
	out, err := c.gitCtx(ctx, req.Cwd, patchArgs...)
	if err != nil {
		res.Rejection = "could not read the patch for commit " + req.Commit + ": " + err.Error()
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree diff commit patch failed", map[string]any{
			"cwd": req.Cwd, "commit": req.Commit, "error": err.Error(),
		})
		return
	}
	res.Patch, res.Truncated = truncatePatch(out)
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree diff commit success", map[string]any{
		"cwd": req.Cwd, "commit": req.Commit, "truncated": res.Truncated, "patch_bytes": len(res.Patch),
	})
}

func (c *Checker) diffCumulative(ctx context.Context, req DiffRequest, entry *WorktreeEntry, res *DiffResult) {
	res.Mode = "cumulative"
	against := req.Against
	if against == "" {
		against = entry.SourceBranch
	}
	res.Against = against
	if against == "" {
		res.Rejection = "no comparison ref was given and " + entry.WorktreePath + " carries no recorded source branch, so the cumulative diff has nothing to compare against"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree diff rejected", map[string]any{
			"cwd": req.Cwd, "worktree_path": entry.WorktreePath, "reason": "no_source_branch",
		})
		return
	}
	if entry.BranchName == "" {
		res.Rejection = "the worktree " + entry.WorktreePath + " carries no recorded branch name, so its diff cannot be resolved"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree diff rejected", map[string]any{
			"cwd": req.Cwd, "worktree_path": entry.WorktreePath, "reason": "no_branch_name",
		})
		return
	}
	spec := against + "..." + entry.BranchName

	statArgs := []string{"diff", "--stat", spec}
	if req.Path != "" {
		statArgs = append(statArgs, "--", req.Path)
	}
	if out, err := c.gitCtx(ctx, req.Cwd, statArgs...); err == nil {
		res.Stat = trimNewline(out)
	} else {
		res.Rejection = "could not diff " + spec + ": " + err.Error()
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree diff cumulative stat failed", map[string]any{
			"cwd": req.Cwd, "spec": spec, "error": err.Error(),
		})
		return
	}

	patchArgs := []string{"diff", spec}
	if req.Path != "" {
		patchArgs = append(patchArgs, "--", req.Path)
	}
	out, err := c.gitCtx(ctx, req.Cwd, patchArgs...)
	if err != nil {
		res.Rejection = "could not read the patch for " + spec + ": " + err.Error()
		utils.LogWithFields(utils.LevelWarn, logTag, "worktree diff cumulative patch failed", map[string]any{
			"cwd": req.Cwd, "spec": spec, "error": err.Error(),
		})
		return
	}
	res.Patch, res.Truncated = truncatePatch(out)
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree diff cumulative success", map[string]any{
		"cwd": req.Cwd, "spec": spec, "truncated": res.Truncated, "patch_bytes": len(res.Patch),
	})
}

func truncatePatch(patch string) (string, bool) {
	if len(patch) <= MaxWorktreeDiffBytes {
		return patch, false
	}
	return patch[:MaxWorktreeDiffBytes], true
}
