package backend

import (
	"strings"

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
// plan signals: the ExitPlanMode tool_use (its argument carries the plan text
// on older claude-code) and any Write to a plans file (newer claude-code
// authors the plan there and calls ExitPlanMode with an empty argument). The
// CLI emits the fully-populated tool input in the assistant message before the
// result event lands, so a captured plan's PlanFileWrittenEvent +
// PlanProposalEvent precede TaskCompleteEvent.
func (b *ClaudeCodeBackend) handlePlanModeAssistant(run *claudeCodeRun, e *types.TaskUpdateEvent) {
	for _, block := range e.Message.Content {
		if block.Type != "tool_use" {
			continue
		}
		switch block.Name {
		case "Write":
			// Stash the content of a Write to a plans file as the fallback plan
			// source. Newer claude-code writes the plan to
			// ~/.claude/plans/<slug>.md (its own plans dir) and then calls
			// ExitPlanMode with no text, so this is where the real plan lives.
			path, _ := block.Input["file_path"].(string)
			content, _ := block.Input["content"].(string)
			if content != "" && isClaudePlansFilePath(path, run.planFilePath) {
				run.pendingPlanFromFile = content
				utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "stashed plan from plans-file write", map[string]any{
					"run_id": run.requestID, "path": path, "bytes": len(content),
				})
			}
		case "ExitPlanMode":
			// The model proposed exiting plan mode — record it regardless of
			// whether the argument carried plan text (see run.sawExitPlanMode).
			run.sawExitPlanMode = true
			plan, _ := block.Input["plan"].(string)
			if plan == "" {
				// Empty argument: the plan (if any) is in a plans-file Write,
				// captured by handlePlanModeResult after all writes are seen.
				utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "ExitPlanMode tool_use carried no plan text (fallback to plans-file write)", map[string]any{
					"run_id": run.requestID, "have_file_plan": run.pendingPlanFromFile != "",
				})
				continue
			}
			if _, err := capturePlanMarkdown(run.requestID, plan, run.planFilePath, true, 0, b.emit); err != nil {
				utils.LogWithFields(utils.LevelError, "backend.claude_code", "native plan capture failed", map[string]any{
					"run_id": run.requestID, "error": err.Error(),
				})
				continue
			}
			run.planCaptured = true
		}
	}
}

// isClaudePlansFilePath reports whether a Write target looks like a plan file:
// the run's own canonical plan file, or a markdown file under any `plans/`
// directory (claude-code's native plans dir is ~/.claude/plans/). Used to
// capture the plan content when ExitPlanMode carries no argument.
func isClaudePlansFilePath(path, runPlanFilePath string) bool {
	if path == "" {
		return false
	}
	if runPlanFilePath != "" && path == runPlanFilePath {
		return true
	}
	return strings.Contains(path, "/plans/") && strings.HasSuffix(path, ".md")
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
	// sawExit is true if the ExitPlanMode tool_use appeared in the assistant
	// stream (the reliable signal — see run.sawExitPlanMode) OR the result
	// carried an ExitPlanMode denial (older claude-code, where ExitPlanMode
	// was not auto-approved). Enrich any such denial with the plan file path
	// so the existing card-render path keeps working.
	sawExit := run.sawExitPlanMode
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

	// Fallback capture: the model exited plan mode with an empty ExitPlanMode
	// argument but authored the plan via a Write to a plans file. Bridge that
	// content into Ion's plan file now (all assistant writes have been seen by
	// TaskCompleteEvent), which emits PlanFileWrittenEvent + PlanProposalEvent
	// ahead of the TaskCompleteEvent — the normal captured-plan surface.
	if sawExit && !run.planCaptured && run.pendingPlanFromFile != "" {
		if _, err := capturePlanMarkdown(run.requestID, run.pendingPlanFromFile, run.planFilePath, true, 0, b.emit); err != nil {
			utils.LogWithFields(utils.LevelError, "backend.claude_code", "native plan capture from plans-file write failed", map[string]any{
				"run_id": run.requestID, "error": err.Error(),
			})
		} else {
			run.planCaptured = true
			utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "captured plan from plans-file write fallback", map[string]any{
				"run_id": run.requestID, "plan_file": run.planFilePath,
			})
		}
	}

	slug := types.PlanSlugFromPath(run.planFilePath)
	switch {
	case sawExit && !run.planCaptured:
		// The model exited plan mode but the stream never yielded a plan
		// argument nor a plans-file write to capture. Surface the proposal so
		// consumers still render the approval card against the (possibly empty)
		// plan file.
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: run.planFilePath,
			PlanSlug:     slug,
		}})
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "exit without captured plan, proposal surfaced (per ADR-003 mode change deferred to user approval)", map[string]any{
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
