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
//
// It also reports `planWriteToCanonical` (this Write/Edit targets the
// canonical plan file, so a successful execution should emit the
// engine_plan_file_written marker) and `planFileHadContentBefore` (the
// plan file already existed with content immediately before this write —
// the created-vs-updated discriminator the marker carries). Both are
// computed pre-execution because that is the only point the engine can
// observe the file's prior state; the post-execution site emits the marker
// using them once the write has actually succeeded.

// planWriteGateResult bundles the gate's reports to the per-tool dispatch
// loop. handled follows the "caller should return nil" idiom; the other
// fields drive the post-execution overwrite warning and the
// engine_plan_file_written marker emission.
type planWriteGateResult struct {
	handled                  bool
	planWriteOverwrite       bool
	redirectNotice           string
	planWriteToCanonical     bool
	planFileHadContentBefore bool
}

// applyPlanModeWriteGate enforces the plan-mode invariant that the
// canonical plan file is the only writable file. The decision is
// three-way:
//
//  1. **Target IS the canonical plan file** → allow. When the tool is
//     Write, latch whether the file already has substantial content so
//     executeTools can append an overwrite warning to the successful
//     tool result.
//  2. **Target is a plan-shaped path inside a recognized plans
//     directory but NOT the canonical plan file** → redirect. The model
//     invented a different plan filename (e.g. on a revision turn). The
//     engine rewrites the tool input's file_path to the canonical
//     run.planFilePath in place and lets the call fall through to normal
//     execution, so at most one plan file per run is ever created — the
//     assigned one — regardless of what name the model chose. The
//     returned redirectNotice tells executeTools to append a note to the
//     successful tool result so the model learns it wrote to the
//     canonical file. This redirect is a no-op when run.planFilePath is
//     empty (prompt-level plan mode with no allocated file): there is no
//     canonical target, so we fall through to the hard block below rather
//     than rewrite to "".
//  3. **Target is any other (non-plan) path** → hard block with a
//     permission-style error. Unchanged behavior.
//
// cwd is the run working directory, used to resolve the recognized
// plans directories for the plan-shaped containment test.
//
// The redirect mutates block.Input["file_path"], which is a map
// (reference type) shared with the executor that dispatches this block
// (see executeTools: tools.ExecuteTool reads block.Input). The in-place
// write is therefore visible to the executor and to the post-execution
// file_changed hook, both of which then see the canonical path.
//
// redirectNotice is non-empty only when a redirect happened; executeTools
// appends it to the successful tool result. It is returned (rather than
// latched on the run) so it stays scoped to this exact tool block — each
// block runs in its own goroutine, so run-level state would race across
// concurrent blocks.
func applyPlanModeWriteGate(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
	cwd string,
	emit func(*activeRun, types.NormalizedEvent),
) planWriteGateResult {
	if !run.planMode || (block.Name != "Write" && block.Name != "Edit") {
		return planWriteGateResult{}
	}
	targetPath, ok := block.Input["file_path"].(string)
	if !ok {
		return planWriteGateResult{}
	}
	// planFileHadContent reports whether the canonical plan file already
	// exists with content immediately before this write — the precise
	// created-vs-updated discriminator for the engine_plan_file_written
	// marker. Computed here (pre-execution) because that is the only point
	// the engine can observe the file's prior state. Any non-empty file
	// counts as "had content"; a missing or zero-byte file is "created".
	planFileHadContent := func() bool {
		if run.planFilePath == "" {
			return false
		}
		info, err := os.Stat(run.planFilePath)
		return err == nil && info.Size() > 0
	}
	if filepath.Clean(targetPath) != filepath.Clean(run.planFilePath) {
		// The model targeted something other than the canonical plan
		// file. If it is still a plan-shaped path (inside a recognized
		// plans directory) and we HAVE a canonical plan file to redirect
		// to, rewrite the target to the canonical path instead of
		// blocking — this is the "model invented a stray plan filename"
		// case (e.g. on a revision turn). Otherwise fall through to the
		// hard block.
		if run.planFilePath != "" && isPlanShapedPath(targetPath, cwd) {
			utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "redirected_plan_write", map[string]any{
				"run_id":    run.requestID,
				"target":    targetPath,
				"canonical": run.planFilePath,
			})
			// Capture prior state BEFORE the redirected write executes.
			hadContent := planFileHadContent()
			// Rewrite the executor-visible input in place.
			block.Input["file_path"] = run.planFilePath
			notice := fmt.Sprintf(
				"NOTE: %s targeted %s, which is not the plan file for this session. "+
					"The engine redirected the write to the canonical plan file (%s). "+
					"Always write the plan to that exact path; do not invent a new plan filename.",
				block.Name, targetPath, run.planFilePath)
			// Fall through to normal execution against the rewritten path.
			// Re-run the overwrite latch against the canonical file so a
			// redirected Write over an existing plan still warns.
			overwrite := block.Name == "Write" && hadContent
			return planWriteGateResult{
				redirectNotice:           notice,
				planWriteOverwrite:       overwrite,
				planWriteToCanonical:     true,
				planFileHadContentBefore: hadContent,
			}
		}
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "event", map[string]any{
			"run_id":    run.requestID,
			"blocked":   block.Name,
			"target":    targetPath,
			"plan_file": run.planFilePath,
		})
		msg := fmt.Sprintf(
			"Plan mode: %s targeted %q — that path is not the plan file for this session. "+
				"Do not retry with that path. Your only valid write target is %s. "+
				"Resubmit your %s call targeting that exact path.",
			block.Name, targetPath, run.planFilePath, block.Name)
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
		return planWriteGateResult{handled: true}
	}
	// Direct write/edit to the canonical plan file. Capture prior state for
	// the created-vs-updated marker and the overwrite warning.
	hadContent := planFileHadContent()
	overwrite := block.Name == "Write" && hadContent
	return planWriteGateResult{
		planWriteOverwrite:       overwrite,
		planWriteToCanonical:     true,
		planFileHadContentBefore: hadContent,
	}
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
		utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "event", map[string]any{
			"run_id":           run.requestID,
			"blocked_bash":     cmdTrimmed,
			"allowed_prefixes": run.planModeAllowedBashCommands,
		})
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
	utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "matched_prefix", map[string]any{
		"run_id":       run.requestID,
		"allowed_bash": cmdTrimmed,
	})
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
