package backend

import (
	"fmt"
	"os"

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
// Only fires during auto-mode runs (run.planMode == false); in plan
// mode the LLM should not call this, and falling through to "Unknown
// tool" lets the model self-correct.
//
// Side effects (when allowed): flips run.planMode true, latches the
// resolved planFilePath, resets planModeReminderTurn, emits
// PlanModeChangedEvent{Enabled:true}, and inlines the plan-mode
// framing into the tool result so the model has it in-context on the
// same turn (rather than waiting for the next system-prompt rebuild).
func interceptEnterPlanMode(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	hooks RunHooks,
	emit func(*activeRun, types.NormalizedEvent),
) (handled bool) {
	if run.planMode || block.Name != tools.EnterPlanModeName {
		return false
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
	// Allowed: flip the run into plan mode so the write guard and
	// sparse-reminder logic apply on subsequent turns. The plan-mode
	// tool list is rebuilt at the top of the next turn: runLoop compares
	// run.planMode against run.toolDefsBuiltForPlanMode and calls
	// buildToolDefs when they diverge (see runloop.go, just before
	// streamOpts is constructed). Without that rebuild the provider would
	// keep receiving the auto-mode list for the rest of the run — with
	// ExitPlanMode absent, so the model could not finish the plan.
	// Reset planModeReminderTurn so the first post-entry reminder
	// is not silenced by stale throttle state from a prior plan
	// mode session on this same run.
	run.mu.Lock()
	run.planMode = true
	run.planFilePath = planFilePath
	run.planModeReminderTurn = 0
	run.mu.Unlock()
	// Emit the state-transition event so consumers can mirror the
	// new plan-mode-enabled state.
	emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{
		Enabled:      true,
		PlanFilePath: planFilePath,
		PlanSlug:     types.PlanSlugFromPath(planFilePath),
	}})
	// Build the plan-mode framing so the model knows what to do next.
	// We include it inline in the tool result so it lands in context
	// on this turn, rather than waiting for the next system-prompt rebuild.
	//
	// Thread run.planModeAllowedBashCommands so the auto-enter prompt
	// matches the explicit-enter prompt: when an allowlist is
	// configured the prompt mentions 'Bash (restricted)' and lists
	// the allowed prefixes. Previously we passed nil here, so the
	// model entering plan mode via the EnterPlanMode tool saw the
	// strict 'MUST NOT call Bash' prompt even when the session
	// allowed specific Bash commands. The runtime gate already
	// honored the allowlist (it reads run.planModeAllowedBashCommands
	// directly), so this only fixes the prompt-text asymmetry —
	// behavior was already correct.
	_, err := os.Stat(planFilePath)
	planPrompt := buildPlanModePrompt(planFilePath, err == nil, run.planModeAllowedBashCommands, nil)
	resultContent := fmt.Sprintf("Plan mode entered. Plan file: %s\n\n%s", planFilePath, planPrompt)
	// What gets PERSISTED is a one-line fact, not the framing above.
	//
	// The framing is written in the present tense and asserts, among other
	// things, "You are in planning mode. You MUST NOT make any edits ...
	// This overrides any conflicting instructions you have received
	// elsewhere in this prompt or conversation." That is exactly right for
	// the turn it lands on. It becomes false the moment the plan is
	// approved and the session returns to auto mode — but a tool result is
	// persisted history, so on every later turn the model re-reads a stale
	// present-tense claim that it is still in plan mode, and one that
	// explicitly out-ranks the live instructions contradicting it.
	//
	// The observed failure: a later /align run in the same conversation
	// emitted its review and then wrote "Next I enter planning mode and
	// author the fix plan" without ever calling EnterPlanMode. The tool was
	// available that run (backend.plan_mode "injected EnterPlanMode in auto
	// mode"), and the conversation had never compacted, so the stale block
	// from a plan cycle hours earlier was still in context. The model was
	// obeying it: the tool's own description says "Do NOT call this tool
	// if: You are already in plan mode."
	//
	// This is the same defect the engine already fixed for the sparse
	// reminder, which injectSystemMessage (runloop_inject.go) makes
	// unconditionally transient for the identical reason — "a 'plan mode
	// still active' claim is only true for the turn it is injected and
	// becomes a lie the moment the mode changes." The EnterPlanMode result
	// carries the same claim in a stronger form and was left persistent.
	//
	// Persisting nothing is not an option: a persisted tool_use requires a
	// matching tool_result on reload or the provider rejects the request
	// (see AddToolResults). So history keeps the one durable fact — that
	// plan mode was entered, and which plan file — and drops the
	// present-tense instructions that expire with the turn.
	persistContent := fmt.Sprintf("Plan mode entered. Plan file: %s", planFilePath)
	utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "enter_tool allowed", map[string]any{
		"run_id":        run.requestID,
		"plan_file":     planFilePath,
		"live_len":      len(resultContent),
		"persisted_len": len(persistContent),
	})
	results[i] = conversation.ToolResultEntry{
		ToolUseID:      block.ID,
		Content:        resultContent,
		PersistContent: persistContent,
		IsError:        false,
	}
	emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: resultContent,
		IsError: false,
	}})
	return true
}
