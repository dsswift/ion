package backend

// Configured dangerous-command patterns in the tool loop.
//
// A deterministic, extension-independent pre-execution refusal that follows
// the contract of the boundaries in runloop_workspaces.go. It reads
// RunConfig.CommandPatterns, not RunConfig.SandboxCfg, so the patterns hold
// for a run whether or not its commands are sandboxed.

import (
	"context"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// checkCommandPatterns refuses a Bash tool call whose command matches one of
// the run's configured dangerous-command patterns. Returns true when the call
// was refused and its result recorded — the caller stops processing that
// tool. A run with no configured patterns passes everything.
func (b *ApiBackend) checkCommandPatterns(
	gCtx context.Context,
	run *activeRun,
	block types.LlmContentBlock,
	cwd string,
	permDenyFn func(runID string, info interface{}),
	telem TelemetryCollector,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if run.cfg == nil || len(run.cfg.CommandPatterns) == 0 || (block.Name != "Bash" && block.Name != "bash") {
		return false
	}
	cmd, ok := block.Input["command"].(string)
	if !ok {
		return false
	}
	matched, hit := sandbox.MatchPatterns(cmd, run.cfg.CommandPatterns)
	if !hit {
		return false
	}

	reason := matched.Reason
	if reason == "" {
		reason = "command matches the blocked pattern " + matched.Pattern
	}

	utils.LogWithFields(utils.LevelInfo, "sandbox", "dangerous command pattern decision", map[string]any{
		"decision":  "deny",
		"tool":      block.Name,
		"pattern":   matched.Pattern,
		"reason":    reason,
		"sandboxed": run.cfg.SandboxCfg != nil,
		"cwd":       cwd,
		"run_id":    run.requestID,
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
			utils.LogWithFields(utils.LevelWarn, "sandbox", "permission_denied hook interrupted during dangerous command pattern refusal", map[string]any{
				"tool": block.Name, "error": hookErr.Error(),
			})
		}
	}

	if telem != nil {
		telem.Event("sandbox.block", map[string]any{
			"tool":            block.Name,
			"reason":          reason,
			"pattern_source":  "custom",
			"command_preview": truncatePreview(cmd, telemPreviewLimit),
		}, buildTelemCtx(run))
	}
	emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "sandbox_blocked", reason)
	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   "Command blocked by policy: " + reason,
		IsError:   true,
	}
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: results[i].Content,
		IsError: true,
	}})
	return true
}
