package backend

// FR-04 git identity enforcement in the tool loop.
//
// Split into its own file (runloop_tools.go is at the file-size cap) but
// follows the exact contract of checkWorkspaceContainment/checkPrincipalBoundary
// in runloop_workspaces.go: a deterministic, extension-independent
// pre-execution refusal, checked beside those boundaries, before hooks and
// execution, so it holds regardless of which extensions are loaded.

import (
	"context"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// stampToolEnv stamps the run's resolved tool environment (RunConfig.ToolEnv
// -- the caller's own opaque EngineConfig.ToolEnv merged with FR-04's
// resolved git author/committer identity, computed once in
// session.buildRunConfig) onto gCtx so local Bash subprocesses inherit it. A
// nil cfg or empty map leaves gCtx unchanged.
func stampToolEnv(gCtx context.Context, cfg *RunConfig) context.Context {
	if cfg == nil || len(cfg.ToolEnv) == 0 {
		return gCtx
	}
	return tools.WithToolEnv(gCtx, cfg.ToolEnv)
}

// gitMutatingSubcommands is the set of git subcommands that create a commit
// (and therefore stamp an author/committer identity into repository
// history). Read-only and non-authoring commands (status, diff, log, push,
// fetch, checkout, branch, stash, reset) are deliberately excluded: FR-04
// only needs to gate the moment an identity is actually recorded, not every
// git invocation.
var gitMutatingSubcommands = map[string]bool{
	"commit":      true,
	"merge":       true,
	"rebase":      true,
	"cherry-pick": true,
	"am":          true,
	"tag":         true,
	"commit-tree": true,
}

// checkGitIdentityRequired refuses a Bash tool call that invokes a
// git-mutating subcommand (see gitMutatingSubcommands) when the run's git
// identity is required but unresolved (RunConfig.GitIdentityRequiredUnresolved
// -- see session.resolveGitIdentity). Returns true when the call was refused
// and its result recorded, mirroring checkWorkspaceContainment/
// checkPrincipalBoundary's contract.
func (b *ApiBackend) checkGitIdentityRequired(
	gCtx context.Context,
	run *activeRun,
	required bool,
	block types.LlmContentBlock,
	cwd string,
	permDenyFn func(runID string, info interface{}),
	telem TelemetryCollector,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if !required || (block.Name != "Bash" && block.Name != "bash") {
		return false
	}
	cmd, ok := block.Input["command"].(string)
	if !ok || cmd == "" {
		return false
	}
	subs := workspaces.GitSubcommandsIn(cmd, cwd)
	var mutating string
	for _, sub := range subs {
		if gitMutatingSubcommands[sub] {
			mutating = sub
			break
		}
	}
	if mutating == "" {
		return false
	}

	reason := "git identity is required but could not be resolved for this session; refusing '" + mutating + "' before it stamps an unattributed commit"

	utils.LogWithFields(utils.LevelInfo, "session", "git identity required but unresolved: refusing mutating git subcommand", map[string]any{
		"decision": "deny",
		"tool":     block.Name,
		"subcmd":   mutating,
		"cwd":      cwd,
		"run_id":   run.requestID,
	})

	if permDenyFn != nil {
		if _, hookErr := runHookCtx(gCtx, func() struct{} {
			permDenyFn(run.requestID, map[string]interface{}{
				"tool_name": block.Name,
				"input":     block.Input,
				"reason":    reason,
			})
			return struct{}{}
		}); hookErr != nil {
			utils.LogWithFields(utils.LevelWarn, "session", "permission_denied hook interrupted during git identity refusal", map[string]any{
				"tool": block.Name, "error": hookErr.Error(),
			})
		}
	}

	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   reason,
		IsError:   true,
	}
	emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "git_identity_unresolved", reason)
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: results[i].Content,
		IsError: true,
	}})
	return true
}
