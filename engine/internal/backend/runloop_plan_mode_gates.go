package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Plan-mode sentinel interceptors, extracted from runloop_tools.go to keep
// executeTools focused on the dispatch loop. Each is invoked once per
// block-iteration and reports whether the caller should short-circuit
// (results[i] set, an emit fired) or proceed. The read-only boundary itself
// lives in plan_policy.go and is applied by applyPlanPolicy.

// interceptExitPlanMode handles the ExitPlanMode sentinel tool call.
// Fires in any mode: in plan mode it's the normal exit flow; outside
// plan mode (prompt-level plan mode from AGENTS.md context) we still
// intercept so the model doesn't see an "Unknown tool" error.
//
// Side effects (when allowed): flips run.exitPlanMode true, appends a
// permission denial for the exit sentinel, and emits a PlanProposalEvent
// {Kind:"exit"} so consumers can render an approval card. The mode
// flip is deferred to user approval — the engine does NOT emit a
// PlanModeChangedEvent{Enabled:false} here. See ADR-003 for the
// state-vs-workflow rationale.
func interceptExitPlanMode(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	hooks RunHooks,
	emit func(*activeRun, types.NormalizedEvent),
) (handled bool) {
	if block.Name != tools.ExitPlanModeName {
		return false
	}
	// Resolve planFilePath: prefer the run's own value, fall back to
	// the session-level value (preserved across plan mode toggles).
	// This closes the gap where a non-plan-mode run inherits an empty
	// planFilePath but the session still knows the path from a prior
	// plan-mode run.
	resolvedPlanFilePath := run.planFilePath
	if resolvedPlanFilePath == "" && hooks.GetSessionPlanFilePath != nil {
		resolvedPlanFilePath = hooks.GetSessionPlanFilePath()
		if resolvedPlanFilePath != "" {
			utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "exit_tool resolved planFilePath from session", map[string]any{
				"run_id":                  run.requestID,
				"resolved_plan_file_path": resolvedPlanFilePath,
			})
		}
	}

	if !run.planMode {
		utils.LogWithFields(utils.LevelWarn, "backend.plan_mode", "exit_tool called outside engine plan mode (prompt-level plan mode detected)", map[string]any{
			"run_id":    run.requestID,
			"plan_file": resolvedPlanFilePath,
		})
	} else {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "exit_tool", map[string]any{
			"run_id":    run.requestID,
			"plan_file": resolvedPlanFilePath,
		})
	}

	// If planFilePath is still empty after session fallback, return an
	// informative error to the model instead of emitting a useless
	// plan_proposal with no path. This prevents consumers from receiving
	// an unactionable approval card.
	if resolvedPlanFilePath == "" {
		utils.LogWithFields(utils.LevelError, "backend.plan_mode", "exit_tool has no planFilePath (run or session) — returning error to model", map[string]any{
			"run_id": run.requestID,
		})
		errMsg := "Plan mode is not active and no plan file is associated with this session. If you are in plan mode, write your plan to the plan file first."
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   errMsg,
			IsError:   true,
		}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: errMsg,
			IsError: true,
		}})
		return true
	}

	// Fire before_plan_mode_exit hook so extensions can veto.
	exitAllowed := true
	exitReason := ""
	if hooks.OnPlanModeExit != nil {
		exitAllowed, exitReason = hooks.OnPlanModeExit(resolvedPlanFilePath)
	}
	if !exitAllowed {
		if exitReason == "" {
			exitReason = "Plan mode exit was declined. Continue planning."
		}
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "exit_tool denied by hook", map[string]any{
			"run_id": run.requestID,
			"reason": exitReason,
		})
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   exitReason,
			IsError:   false,
		}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: exitReason,
			IsError: false,
		}})
		return true
	}

	run.mu.Lock()
	run.exitPlanMode = true
	run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
		ToolName:  block.Name,
		ToolUseID: block.ID,
		ToolInput: map[string]any{"planFilePath": resolvedPlanFilePath},
	})
	run.mu.Unlock()
	// No PlanModeChangedEvent{Enabled:false} emit here. The model
	// calling ExitPlanMode is a *proposal*, not a confirmed mode
	// change — the user must still approve. The run-end signal
	// (task_complete carrying the ExitPlanMode PermissionDenial)
	// is the canonical card-trigger. Consumers flip their mode to
	// 'auto' only when the user approves via their UI chokepoint.
	//
	// Emit the new PlanProposalEvent{Kind:"exit"} as the primary,
	// first-class workflow signal so consumers can listen for a
	// purpose-built event instead of inferring proposal-state from
	// task_complete + permissionDenials. The permission denial
	// path keeps flowing through engine_status for back-compat
	// (the existing approval-card render path keys off it), and
	// task_complete keeps carrying the denial too. The proposal
	// event is additive — consumers can migrate at their own
	// pace. See docs/architecture/adr/003-state-events-vs-workflow-events.md.
	emit(run, types.NormalizedEvent{Data: &types.PlanProposalEvent{
		Kind:         "exit",
		PlanFilePath: resolvedPlanFilePath,
		PlanSlug:     types.PlanSlugFromPath(resolvedPlanFilePath),
	}})
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "exit_tool emit plan_proposal kind=exit (mode change deferred to user approval)", map[string]any{
		"run_id":    run.requestID,
		"plan_file": resolvedPlanFilePath,
	})
	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   "Plan mode exited.",
		IsError:   false,
	}
	emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: "Plan mode exited.",
		IsError: false,
	}})
	return true
}

// interceptEnterPlanMode handles the EnterPlanMode sentinel tool call.
//
// The tool is in the list in every mode, so the answer depends on the run:
//
//   - Already planning: nothing to do; the model is told so.
//   - Implementing an approved plan (RunOptions.ImplementationPhase): refused.
//     The harness handed this run a plan to carry out, and a fresh plan-mode
//     entry part-way through is exactly what that flag rules out.
//   - Otherwise: the before_plan_mode_enter hook decides.
//
// Side effects (when allowed): flips run.planMode true, latches the
// resolved planFilePath, and emits PlanModeChangedEvent{Enabled:true}.
func interceptEnterPlanMode(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	hooks RunHooks,
	emit func(*activeRun, types.NormalizedEvent),
) (handled bool) {
	if block.Name != tools.EnterPlanModeName {
		return false
	}
	answer := func(content, outcome string) bool {
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "enter_tool answered without a mode change", map[string]any{
			"run_id":  run.requestID,
			"outcome": outcome,
		})
		results[i] = conversation.ToolResultEntry{ToolUseID: block.ID, Content: content}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: block.ID, Content: content}})
		return true
	}
	if run.planMode {
		return answer("Plan mode is already active. Keep planning, and call "+tools.ExitPlanModeName+" when the plan is ready.", "already_planning")
	}
	if run.opts != nil && run.opts.ImplementationPhase {
		return answer("Plan mode is not available: this run is carrying out a plan that was already approved. Continue the implementation.", "implementation_phase")
	}
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "enter_tool requested", map[string]any{
		"run_id": run.requestID,
	})
	var allowed bool
	var reason string
	var planFilePath string
	if hooks.OnPlanModeEnter != nil {
		allowed, reason, planFilePath = hooks.OnPlanModeEnter()
	} else {
		// No hook wired — auto-approve (default behaviour).
		allowed = true
	}
	if !allowed {
		if reason == "" {
			reason = "Plan mode entry was declined."
		}
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "enter_tool denied", map[string]any{
			"run_id": run.requestID,
			"reason": reason,
		})
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   reason,
			IsError:   false,
		}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: reason,
			IsError: false,
		}})
		return true
	}
	// Allowed: flip the run into plan mode so the plan policy applies from
	// the next tool call.
	run.mu.Lock()
	run.planMode = true
	run.planFilePath = planFilePath
	run.mu.Unlock()
	// Emit the state-transition event so consumers can mirror the
	// new plan-mode-enabled state.
	emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
		Enabled:      true,
		PlanFilePath: planFilePath,
		PlanSlug:     types.PlanSlugFromPath(planFilePath),
	}})
	// The result is the one durable fact: plan mode was entered, and which
	// plan file. The instructions follow as a plan_mode_enter notice at the
	// top of the next turn (reconcilePlanMode), which is what the model reads
	// before it acts again.
	resultContent := fmt.Sprintf("Plan mode entered. Plan file: %s", planFilePath)
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "enter_tool allowed", map[string]any{
		"run_id":    run.requestID,
		"plan_file": planFilePath,
	})
	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   resultContent,
		IsError:   false,
	}
	emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: resultContent,
		IsError: false,
	}})
	return true
}
