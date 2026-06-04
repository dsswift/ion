package backend

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Per-tool plan-mode gates, extracted from runloop_tools.go to keep
// executeTools focused on the dispatch loop. Each gate is invoked once
// per block-iteration and reports back whether the caller should
// short-circuit (set results[i], emit, return nil from the per-tool
// goroutine) or proceed.
//
// The gates were inline in executeTools and grew with the bash-allowlist
// addition (commit 8f4493c8); this extraction is mechanical motion. The
// behavior is unchanged; the test surface
// (runloop_tools_plan_gate_test.go) still drives executeTools end-to-end
// and pins the gates' user-visible effects.
//
// Signatures share a common shape: each gate receives the run, the
// current block, the per-block result slot, the result-emit hook
// (b.emit via ApiBackend), and any hook-callback wiring it needs.
// Return values follow the "what should the caller do next?" idiom:
//
//   - handled=false → no plan-mode short-circuit; proceed to the next
//     gate (or to tool execution after all gates run).
//   - handled=true  → results[i] already set, an emit already fired;
//     the caller should `return nil` from the per-tool goroutine.
//
// The Write gate additionally reports `planWriteOverwrite` (latched
// for the post-execution warning that executeTools appends to the
// Write result after the tool actually runs).

// applyPlanModeWriteGate enforces the plan-mode invariant that only
// the plan file is writable. When the tool is Write or Edit and the
// target is not the plan file, it blocks the call and records a
// permission-style error. When the tool is Write *and* the target IS
// the plan file, it latches whether the file already has substantial
// content so executeTools can append an overwrite warning to the
// successful tool result.
func applyPlanModeWriteGate(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	emit func(*activeRun, types.NormalizedEvent),
) (handled bool, planWriteOverwrite bool) {
	if !run.planMode || (block.Name != "Write" && block.Name != "Edit") {
		return false, false
	}
	targetPath, ok := block.Input["file_path"].(string)
	if !ok {
		return false, false
	}
	if filepath.Clean(targetPath) != filepath.Clean(run.planFilePath) {
		utils.Info("PlanMode", fmt.Sprintf("run=%s blocked=%s target=%s plan_file=%s", run.requestID, block.Name, targetPath, run.planFilePath))
		msg := fmt.Sprintf("Plan mode: cannot write to %s. Only the plan file (%s) is writable.", targetPath, run.planFilePath)
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   msg,
			IsError:   true,
		}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: msg,
			IsError: true,
		}})
		return true, false
	}
	// Track whether Write is overwriting existing plan content.
	if block.Name == "Write" {
		if info, err := os.Stat(run.planFilePath); err == nil && info.Size() > 50 {
			return false, true
		}
	}
	return false, false
}

// applyPlanModeBashGate enforces the plan-mode Bash allowlist. When
// the session has a non-empty planModeAllowedBashCommands list, Bash
// is included in the plan-mode tool list but execution is gated by
// token-based prefix matching against the allowlist. Token-based
// matching prevents false positives like "ghost" matching "gh".
//
// The gate is a no-op when the run is not in plan mode, when the tool
// is not Bash, or when the allowlist is empty (default-deny via the
// tool-list filter, not via this gate).
//
// > **Contract — Bash gate semantics.** Matching is case-sensitive,
// > whitespace-delimited tokens, exact-string per token, first-N
// > tokens of the command must match all tokens of an allowlist
// > entry. See docs/protocol/client-commands.md § set_plan_mode for
// > the public consumer-facing claim.
func applyPlanModeBashGate(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	emit func(*activeRun, types.NormalizedEvent),
) (handled bool) {
	if !run.planMode || (block.Name != "Bash" && block.Name != "bash") || len(run.planModeAllowedBashCommands) == 0 {
		return false
	}
	cmd, ok := block.Input["command"].(string)
	if !ok {
		return false
	}
	cmdTrimmed := strings.TrimSpace(cmd)
	cmdAllowed := false
	for _, prefix := range run.planModeAllowedBashCommands {
		prefixTokens := strings.Fields(prefix)
		cmdTokens := strings.Fields(cmdTrimmed)
		if len(cmdTokens) >= len(prefixTokens) {
			match := true
			for j, pt := range prefixTokens {
				if cmdTokens[j] != pt {
					match = false
					break
				}
			}
			if match {
				cmdAllowed = true
				break
			}
		}
	}
	if !cmdAllowed {
		utils.Info("PlanMode", fmt.Sprintf("run=%s blocked_bash=%q allowed_prefixes=%v", run.requestID, cmdTrimmed, run.planModeAllowedBashCommands))
		msg := fmt.Sprintf("Plan mode: Bash command %q is not in the allowed list. Allowed command prefixes: %v", cmdTrimmed, run.planModeAllowedBashCommands)
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   msg,
			IsError:   true,
		}
		emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: msg,
			IsError: true,
		}})
		return true
	}
	utils.Debug("PlanMode", fmt.Sprintf("run=%s allowed_bash=%q matched_prefix", run.requestID, cmdTrimmed))
	return false
}

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
			utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool resolved planFilePath from session: %s", run.requestID, resolvedPlanFilePath))
		}
	}

	if !run.planMode {
		utils.Warn("PlanMode", fmt.Sprintf("run=%s exit_tool called outside engine plan mode (prompt-level plan mode detected) plan_file=%s", run.requestID, resolvedPlanFilePath))
	} else {
		utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool plan_file=%s", run.requestID, resolvedPlanFilePath))
	}

	// If planFilePath is still empty after session fallback, return an
	// informative error to the model instead of emitting a useless
	// plan_proposal with no path. This prevents consumers from receiving
	// an unactionable approval card.
	if resolvedPlanFilePath == "" {
		utils.Error("PlanMode", fmt.Sprintf("run=%s exit_tool has no planFilePath (run or session) — returning error to model", run.requestID))
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
		utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool denied by hook reason=%q", run.requestID, exitReason))
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
	utils.Info("PlanMode", fmt.Sprintf("run=%s exit_tool emit plan_proposal kind=exit planFile=%s (mode change deferred to user approval)", run.requestID, resolvedPlanFilePath))
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
	utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool requested", run.requestID))
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
		utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool denied reason=%q", run.requestID, reason))
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
	// tool list will be rebuilt on the next call to buildToolDefs.
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
	planPrompt := buildPlanModePrompt(planFilePath, err == nil, run.planModeAllowedBashCommands)
	resultContent := fmt.Sprintf("Plan mode entered. Plan file: %s\n\n%s", planFilePath, planPrompt)
	utils.Info("PlanMode", fmt.Sprintf("run=%s enter_tool allowed planFile=%s", run.requestID, planFilePath))
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
