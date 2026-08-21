package workspaces

// WorktreeList: "what other worktrees exist for this repo".
//
// See worktree_query.go for the package-level rationale and the safety
// property (every git call runs in the CALLER's own directory).

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// WorktreeListEntry is one worktree in the group, decorated with the cheap
// facts a caller deciding where to look next needs without a follow-up call.
type WorktreeListEntry struct {
	WorktreePath string `json:"worktreePath"`
	RepoPath     string `json:"repoPath"`
	BranchName   string `json:"branchName,omitempty"`
	SourceBranch string `json:"sourceBranch,omitempty"`
	Title        string `json:"title,omitempty"`
	CreatedAt    int64  `json:"createdAt,omitempty"`
	LandedAt     int64  `json:"landedAt,omitempty"`
	Landed       bool   `json:"landed,omitempty"`
	// IsSelf is true for the entry matching the calling conversation's own
	// cwd.
	IsSelf bool `json:"isSelf,omitempty"`
	// ExistsOnDisk is false when the registry still lists a worktree whose
	// checkout was removed outside Ion's own lifecycle management.
	ExistsOnDisk bool `json:"existsOnDisk"`
	// HeadSha/HeadSubject are the branch's current HEAD, read via the shared
	// object store from the CALLER's own directory — never by visiting the
	// entry's worktree path. Empty when the branch could not be resolved
	// (e.g. ExistsOnDisk is false and nothing else in the repo references it).
	HeadSha     string `json:"headSha,omitempty"`
	HeadSubject string `json:"headSubject,omitempty"`
	// UnlandedCount is commits on BranchName not reachable from SourceBranch.
	// Absent (UnlandedCountKnown false) when SourceBranch is empty or
	// unresolvable, rather than a misleading zero.
	UnlandedCount      int  `json:"unlandedCount,omitempty"`
	UnlandedCountKnown bool `json:"unlandedCountKnown,omitempty"`
}

// WorktreeListResult is the complete answer. Never an error: an empty group
// is a real and useful answer (nothing registered for this repo), stated via
// Rejection rather than failing the call.
type WorktreeListResult struct {
	RepoPath  string              `json:"repoPath,omitempty"`
	Entries   []WorktreeListEntry `json:"entries"`
	Rejection string              `json:"rejection,omitempty"`
}

// WorktreeList answers "what worktrees exist for the repo containing cwd".
// Read-only: every git call below runs with cwd as its directory, never any
// entry's WorktreePath.
func (c *Checker) WorktreeList(ctx context.Context, cwd string) WorktreeListResult {
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree list start", map[string]any{
		"cwd": cwd,
	})
	res := WorktreeListResult{}
	if c == nil {
		res.Rejection = "workspace containment is disabled, so there is no worktree registry to query"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree list rejected", map[string]any{
			"cwd": cwd, "reason": "nil_checker",
		})
		return res
	}
	repoPath, entries, self := c.worktreeGroup(cwd)
	if repoPath == "" {
		res.Rejection = cwd + " is not inside a registered worktree or a repository with registered worktrees"
		utils.LogWithFields(utils.LevelInfo, logTag, "worktree list rejected", map[string]any{
			"cwd": cwd, "reason": "unrelated_directory",
		})
		return res
	}
	res.RepoPath = repoPath

	for _, e := range entries {
		// A landed checkout that was removed from disk is finished work, not a
		// usable worktree. Keep active missing entries visible so callers can still
		// inspect their branch through the shared object store and recover work.
		exists := existsOnDisk(e.WorktreePath)
		if e.Landed() && !exists {
			utils.LogWithFields(utils.LevelInfo, logTag, "worktree list skipped missing landed checkout", map[string]any{
				"cwd": cwd, "repo": repoPath, "worktree_path": e.WorktreePath,
				"branch": e.BranchName, "landed_at": e.LandedAt,
			})
			continue
		}
		item := WorktreeListEntry{
			WorktreePath: e.WorktreePath,
			RepoPath:     e.RepoPath,
			BranchName:   e.BranchName,
			SourceBranch: e.SourceBranch,
			Title:        e.Title,
			CreatedAt:    e.CreatedAt,
			LandedAt:     e.LandedAt,
			Landed:       e.Landed(),
			IsSelf:       self != nil && self.WorktreePath == e.WorktreePath,
			ExistsOnDisk: exists,
		}
		item.HeadSha, item.HeadSubject = c.headSummary(ctx, cwd, e.BranchName)
		if n, ok := c.unlandedCount(ctx, cwd, e.SourceBranch, e.BranchName); ok {
			item.UnlandedCount, item.UnlandedCountKnown = n, true
		}
		res.Entries = append(res.Entries, item)
	}
	utils.LogWithFields(utils.LevelDebug, logTag, "worktree list success", map[string]any{
		"cwd": cwd, "repo": repoPath, "entry_count": len(res.Entries),
	})
	return res
}
