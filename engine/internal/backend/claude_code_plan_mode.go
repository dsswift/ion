package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Plan-mode handling for the claude-code delegated CLI. The CLI's native plan
// mode (--permission-mode plan) owns the behavioral framework: read-only
// tools, plan phases, and the ExitPlanMode call whose ARGUMENT carries the
// plan text. The engine's job is capture + normalization: pull the plan
// markdown from the native tool argument, bridge it into Ion's file-centric
// contract via capturePlanMarkdown, and keep the event order identical to the
// ApiBackend reference (proposal before task-complete).

// handlePlanModeAssistant scans a streamed assistant message for the native
// ExitPlanMode tool_use and captures its plan argument. The CLI emits the
// fully-populated tool input in the assistant message before the result event
// lands, so this fires ahead of the denial and the helper's
// PlanFileWrittenEvent + PlanProposalEvent precede TaskCompleteEvent.
func (b *ClaudeCodeBackend) handlePlanModeAssistant(run *claudeCodeRun, e *types.TaskUpdateEvent) {
	for _, block := range e.Message.Content {
		if block.Type != "tool_use" || block.Name != "ExitPlanMode" {
			continue
		}
		plan, _ := block.Input["plan"].(string)
		if plan == "" {
			utils.LogWithFields(utils.LevelWarn, "backend.claude_code", "ExitPlanMode tool_use carried no plan text", map[string]any{
				"run_id": run.requestID,
			})
			return
		}
		if _, err := capturePlanMarkdown(run.requestID, plan, run.planFilePath, true, 0, b.emit); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.claude_code", "native plan capture failed", map[string]any{
				"run_id": run.requestID, "error": err.Error(),
			})
			return
		}
		run.planCaptured = true
		return
	}
}

// handlePlanModeResult processes the CLI's result event for a plan-mode run,
// before the TaskCompleteEvent is emitted. Three concerns:
//
//  1. Enrich the ExitPlanMode PermissionDenial with the plan file path (the
//     CLI wire format doesn't carry it) so the existing card-render path that
//     reads denials keeps working.
//  2. Fallback proposal: when the denial is present but the streamed capture
//     never fired (the tool_use carried no plan text), surface the proposal
//     anyway so the run doesn't end silently in plan mode.
//  3. Auto-exit safety net: when the turn ended with NO ExitPlanMode at all,
//     synthesize PlanModeAutoExitEvent + PlanProposalEvent (mirroring the
//     ApiBackend's end-of-turn synthesis) unless disabled via
//     RunOptions.PlanModeAutoExit.
//
// Per ADR-003: the model calling ExitPlanMode is a *proposal*, not a
// confirmed mode change — no PlanModeChangedEvent{Enabled:false} is emitted
// here; the mode flip is deferred to the user-approval chokepoint.
func (b *ClaudeCodeBackend) handlePlanModeResult(run *claudeCodeRun, e *types.TaskCompleteEvent, opts *types.RunOptions) {
	sawExit := false
	for i := range e.PermissionDenials {
		if e.PermissionDenials[i].ToolName != "ExitPlanMode" {
			continue
		}
		sawExit = true
		if run.planFilePath != "" {
			e.PermissionDenials[i].ToolInput = map[string]any{
				"planFilePath": run.planFilePath,
			}
		}
		break
	}

	slug := types.PlanSlugFromPath(run.planFilePath)
	switch {
	case sawExit && !run.planCaptured:
		// The model exited plan mode but the stream never yielded a plan
		// argument to capture. Surface the proposal so consumers still render
		// the approval card against the (possibly empty) plan file.
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "exit denial without captured plan, proposal surfaced (per ADR-003 mode change deferred to user approval)", map[string]any{
			"run_id": run.requestID, "plan_file": run.planFilePath,
		})

	case !sawExit && !run.planCaptured && resolveCliPlanModeAutoExit(opts):
		// Turn ended in plan mode with no ExitPlanMode — the stuck-in-plan-mode
		// failure mode. Synthesize the exit so the approval card surfaces,
		// mirroring the ApiBackend's runloop_plan_mode_auto_exit path.
		reason := "engine-synthesized: run ended in plan mode without ExitPlanMode call"
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeAutoExitEvent{
			RunID:        run.requestID,
			StopReason:   "end_turn",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
			Reason:       reason,
		}})
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "plan mode auto-exit synthesized", map[string]any{
			"run_id": run.requestID, "plan_file": run.planFilePath,
		})
	}
}
