package backend

// Workspace-containment enforcement in the tool loop.
//
// Split from runloop_tools.go (file-size cap) at the policy seam: this is the
// engine's deterministic baseline for worktree/bench containment
// (internal/workspaces), checked beside the permission engine — before hooks,
// before execution — so a refusal holds regardless of which extensions are
// loaded. A refusal short-circuits exactly like a permission deny: the typed
// reason is the tool result the model reads, and the permission_denied
// observability path fires so consumers see it without new event surface.
// Extensions can layer STRICTER policy via the tool_call hook; they cannot
// loosen this baseline.

import (
	"context"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

// checkWorkspaceContainment evaluates one tool call against the workspace
// checker. Returns true when the call was refused and its result recorded —
// the caller stops processing that tool. A nil checker (feature disabled or
// not threaded) passes everything.
func (b *ApiBackend) checkWorkspaceContainment(
	gCtx context.Context,
	run *activeRun,
	checker *workspaces.Checker,
	block types.LlmContentBlock,
	cwd string,
	permDenyFn func(runID string, info interface{}),
	telem TelemetryCollector,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if checker == nil {
		return false
	}
	refusal := checker.Check(block.Name, block.Input, cwd)
	if refusal == nil {
		return false
	}

	utils.LogWithFields(utils.LevelInfo, "workspaces", "tool call refused by workspace containment", map[string]any{
		"tool":   block.Name,
		"kind":   string(refusal.Kind),
		"target": refusal.Target,
		"cwd":    cwd,
		"run_id": run.requestID,
	})

	if permDenyFn != nil {
		if _, hookErr := runHookCtx(gCtx, func() struct{} {
			permDenyFn(run.requestID, map[string]interface{}{
				"tool_name": block.Name,
				"input":     block.Input,
				"reason":    refusal.Reason,
			})
			return struct{}{}
		}); hookErr != nil {
			// The run context is gone; the caller's errgroup surfaces it.
			// Record the refusal result anyway so the entry is not empty.
			utils.LogWithFields(utils.LevelWarn, "workspaces", "permission_denied hook interrupted during workspace refusal", map[string]any{
				"tool": block.Name, "error": hookErr.Error(),
			})
		}
	}

	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   refusal.Reason,
		IsError:   true,
	}
	emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "workspace_containment", refusal.Reason)
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: results[i].Content,
		IsError: true,
	}})
	return true
}

// checkAndWrapSandbox validates a Bash command against the sandbox config and
// wraps it for sandboxed execution. Returns true when the command was blocked
// and its result recorded — the caller stops processing that tool. Lives here
// (with the workspace check) because both are the pre-execution policy seam
// the tool loop runs before hooks; runloop_tools.go is at its size cap.
func (b *ApiBackend) checkAndWrapSandbox(
	run *activeRun,
	sbCfg *sandbox.Config,
	block *types.LlmContentBlock,
	telem TelemetryCollector,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if sbCfg == nil || (block.Name != "Bash" && block.Name != "bash") {
		return false
	}
	cmd, ok := block.Input["command"].(string)
	if !ok {
		return false
	}

	safe, reason, patternSource := sandbox.ValidateWithConfig(cmd, *sbCfg)
	if !safe {
		if telem != nil {
			// R11: event name is carried by Event.Name; payload.kind removed.
			telem.Event("sandbox.block", map[string]any{
				"tool":            block.Name,
				"reason":          reason,
				"pattern_source":  patternSource,
				"command_preview": truncatePreview(cmd, telemPreviewLimit),
			}, buildTelemCtx(run))
		}
		emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "sandbox_blocked", reason)
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   "Sandbox blocked: " + reason,
			IsError:   true,
		}
		b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: results[i].Content,
			IsError: true,
		}})
		return true
	}

	// After validation passes, wrap for sandboxed execution.
	if wrapped, err := sandbox.WrapCommand(cmd, *sbCfg, ""); err == nil && wrapped != cmd {
		block.Input["command"] = wrapped
	}
	return false
}
