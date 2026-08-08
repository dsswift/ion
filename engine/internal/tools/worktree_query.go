package tools

// Cross-worktree read-only query tools: WorktreeList, WorktreeCommits,
// WorktreeDiff.
//
// Engine-core, generic worktree mechanism (see
// internal/workspaces/worktree_query.go for the full rationale) -- distinct
// from Ion's bench-specific tools (WorkspaceAttribution, BenchMemberFile,
// BenchResolutionHistory), which moved to the desktop's client tool gate
// under ADR-025 because the bench is a product, not a git concept. These
// three ARE generic worktree mechanism, so they are registered globally here,
// exactly like Read/Grep/Glob.
//
// All three are read-only and PlanModeSafe: nothing here writes, and every
// git invocation is a query run in the CALLING conversation's own directory
// (see worktree_query.go's ctxGitRunner) -- never in a sibling worktree's
// path.

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

const (
	WorktreeListName    = "WorktreeList"
	WorktreeCommitsName = "WorktreeCommits"
	WorktreeDiffName    = "WorktreeDiff"
)

// ─── WorktreeList ────────────────────────────────────────────────────────────

// WorktreeListTool returns the read-only worktree-enumeration tool.
func WorktreeListTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        WorktreeListName,
		Description: "List every worktree registered for the repository containing the current directory, including this one. Each entry carries its branch, source branch, title, landed status, and (when resolvable) its current HEAD commit and how many commits it holds that have not yet reached its source branch. Read-only: every git query runs in the CALLING conversation's own directory, never inside another worktree's checkout.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		PlanModeSafe: true,
		Execute:      executeWorktreeList,
	}
}

func executeWorktreeList(ctx context.Context, _ map[string]any, cwd string) (*types.ToolResult, error) {
	utils.LogWithFields(utils.LevelInfo, "tools.worktree_list", "worktree list started", map[string]any{"cwd": cwd})
	result := workspaces.SharedChecker().WorktreeList(ctx, cwd)
	raw, err := json.Marshal(result)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "tools.worktree_list", "worktree list result serialization failed", map[string]any{"cwd": cwd, "error": err.Error()})
		return nil, fmt.Errorf("marshal worktree list result: %w", err)
	}
	if result.Rejection != "" {
		utils.LogWithFields(utils.LevelWarn, "tools.worktree_list", "worktree list rejected", map[string]any{"cwd": cwd, "reason": result.Rejection})
		return &types.ToolResult{Content: string(raw), IsError: true}, nil
	}
	utils.LogWithFields(utils.LevelInfo, "tools.worktree_list", "worktree list completed", map[string]any{
		"cwd": cwd, "repo_path": result.RepoPath, "entry_count": len(result.Entries),
	})
	return &types.ToolResult{Content: string(raw)}, nil
}

// ─── WorktreeCommits ─────────────────────────────────────────────────────────

// WorktreeCommitsTool returns the read-only commit-log tool.
func WorktreeCommitsTool() *types.ToolDef {
	return &types.ToolDef{
		Name: WorktreeCommitsName,
		Description: "Show the commit log for one worktree's branch (a sibling worktree of the same repository, or this one). Reads through the shared git object store from the CALLING conversation's own directory -- never by opening the target worktree's checkout. Use before starting work to check whether a sibling worktree has already built what you are about to build.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"worktree": map[string]any{"type": "string", "description": "Branch name or worktree path to inspect. Defaults to this conversation's own worktree when omitted."},
				"limit":    map[string]any{"type": "integer", "minimum": 1, "description": "Maximum number of commits to return. Defaults to 20, capped at 100."},
				"path":     map[string]any{"type": "string", "description": "Optional file or directory path to scope the log to."},
			},
		},
		PlanModeSafe: true,
		Execute:      executeWorktreeCommits,
	}
}

func executeWorktreeCommits(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	worktree, _ := input["worktree"].(string) //nolint:errcheck // non-string reads as absent; resolves to self downstream
	path, _ := input["path"].(string)         //nolint:errcheck // non-string reads as absent
	limit, limitErr := optionalPositiveInt(input, "limit")
	if limitErr != nil {
		return worktreeToolError(WorktreeCommitsName, limitErr.Error()), nil
	}

	utils.LogWithFields(utils.LevelInfo, "tools.worktree_commits", "worktree commits started", map[string]any{
		"cwd": cwd, "worktree": worktree, "limit": limit, "path": path,
	})
	result := workspaces.SharedChecker().Commits(ctx, workspaces.CommitsRequest{
		Cwd: cwd, Worktree: worktree, Limit: limit, Path: path,
	})
	raw, err := json.Marshal(result)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "tools.worktree_commits", "worktree commits result serialization failed", map[string]any{"cwd": cwd, "error": err.Error()})
		return nil, fmt.Errorf("marshal worktree commits result: %w", err)
	}
	if result.Rejection != "" {
		utils.LogWithFields(utils.LevelWarn, "tools.worktree_commits", "worktree commits rejected", map[string]any{"cwd": cwd, "worktree": worktree, "reason": result.Rejection})
		return &types.ToolResult{Content: string(raw), IsError: true}, nil
	}
	utils.LogWithFields(utils.LevelInfo, "tools.worktree_commits", "worktree commits completed", map[string]any{
		"cwd": cwd, "branch": result.BranchName, "commit_count": len(result.Commits),
	})
	return &types.ToolResult{Content: string(raw)}, nil
}

// ─── WorktreeDiff ────────────────────────────────────────────────────────────

// WorktreeDiffTool returns the read-only diff tool.
func WorktreeDiffTool() *types.ToolDef {
	return &types.ToolDef{
		Name: WorktreeDiffName,
		Description: "Show a diff for one worktree's branch (a sibling worktree of the same repository, or this one): either one specific commit, or everything the branch has done since it diverged from its source branch. Reads through the shared git object store from the CALLING conversation's own directory -- never by opening the target worktree's checkout. Large diffs are truncated (stated in the result) after a stat summary that always survives.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"worktree": map[string]any{"type": "string", "description": "Branch name or worktree path to inspect. Defaults to this conversation's own worktree when omitted."},
				"commit":   map[string]any{"type": "string", "description": "Show exactly this commit sha. When omitted, shows everything the branch has done since diverging from its source (or from 'against')."},
				"against":  map[string]any{"type": "string", "description": "Comparison ref for the cumulative diff. Ignored when 'commit' is set. Defaults to the worktree's recorded source branch."},
				"path":     map[string]any{"type": "string", "description": "Optional file or directory path to scope the diff to."},
			},
		},
		PlanModeSafe: true,
		Execute:      executeWorktreeDiff,
	}
}

func executeWorktreeDiff(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	worktree, _ := input["worktree"].(string) //nolint:errcheck // non-string reads as absent; resolves to self downstream
	commit, _ := input["commit"].(string)     //nolint:errcheck // non-string reads as absent
	against, _ := input["against"].(string)   //nolint:errcheck // non-string reads as absent
	path, _ := input["path"].(string)         //nolint:errcheck // non-string reads as absent

	utils.LogWithFields(utils.LevelInfo, "tools.worktree_diff", "worktree diff started", map[string]any{
		"cwd": cwd, "worktree": worktree, "commit": commit, "against": against, "path": path,
	})
	result := workspaces.SharedChecker().Diff(ctx, workspaces.DiffRequest{
		Cwd: cwd, Worktree: worktree, Commit: commit, Against: against, Path: path,
	})
	raw, err := json.Marshal(result)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "tools.worktree_diff", "worktree diff result serialization failed", map[string]any{"cwd": cwd, "error": err.Error()})
		return nil, fmt.Errorf("marshal worktree diff result: %w", err)
	}
	if result.Rejection != "" {
		utils.LogWithFields(utils.LevelWarn, "tools.worktree_diff", "worktree diff rejected", map[string]any{"cwd": cwd, "worktree": worktree, "reason": result.Rejection})
		return &types.ToolResult{Content: string(raw), IsError: true}, nil
	}
	utils.LogWithFields(utils.LevelInfo, "tools.worktree_diff", "worktree diff completed", map[string]any{
		"cwd": cwd, "branch": result.BranchName, "mode": result.Mode, "truncated": result.Truncated, "patch_len": len(result.Patch),
	})
	return &types.ToolResult{Content: string(raw)}, nil
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

func worktreeToolError(toolName, message string) *types.ToolResult {
	utils.LogWithFields(utils.LevelWarn, "tools.worktree_query", "input rejected", map[string]any{"tool": toolName, "reason": message})
	return &types.ToolResult{Content: "Error: " + message, IsError: true}
}

// optionalPositiveInt reads an optional positive-integer argument. Absent
// yields 0 with no error. Mirrors the convention the (now-moved) bench tools
// used before ADR-025.
func optionalPositiveInt(input map[string]any, key string) (int, error) {
	value, exists := input[key]
	if !exists || value == nil {
		return 0, nil
	}
	var n int
	switch typed := value.(type) {
	case int:
		n = typed
	case float64:
		if typed != float64(int(typed)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		n = int(typed)
	default:
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if n < 1 {
		return 0, fmt.Errorf("%s must be 1 or greater", key)
	}
	return n, nil
}
