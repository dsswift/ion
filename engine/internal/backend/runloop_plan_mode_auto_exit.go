package backend

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Deterministic plan-mode exit synthesis (issue #187).
//
// When a plan-mode run terminates with stop reason end_turn / stop and
// the assistant did not invoke ExitPlanMode or AskUserQuestion, the
// engine synthesizes the ExitPlanMode call so consumers reliably see
// the plan-approval card instead of the conversation being parked in
// plan mode.
//
// The synthesis path is fully configurable: engine.json
// (LimitsConfig.PlanModeAutoExitOnEndTurn), per-run override
// (RunOptions.PlanModeAutoExit), and the before_plan_mode_auto_exit
// hook can each disable it. Defaults to on because the
// stuck-in-plan-mode failure mode is strictly worse than the (cheap,
// idempotent) auto-exit.
//
// See:
//   - docs/architecture/adr/005-plan-mode-auto-exit.md for the design
//     rationale and the on-by-default decision.
//   - docs/hooks/reference.md (Plan Mode group) for the hook contract.

// resolvePlanModeAutoExit folds the three configuration layers into a
// single effective boolean for this run. Precedence (highest wins):
//  1. RunOptions.PlanModeAutoExit (per-run pointer)
//  2. RunConfig.PlanModeAutoExitOnEndTurn (engine.json LimitsConfig)
//  3. Built-in default (true)
//
// The before_plan_mode_auto_exit hook is NOT consulted here — that hook
// fires at synthesis time (in maybeSynthesizeExitPlanMode below) and
// runs last in the precedence chain so handlers see the assistant's
// final turn before deciding.
func resolvePlanModeAutoExit(opts *types.RunOptions, cfg *RunConfig) bool {
	if opts != nil && opts.PlanModeAutoExit != nil {
		return *opts.PlanModeAutoExit
	}
	if cfg != nil && cfg.PlanModeAutoExitOnEndTurn != nil {
		return *cfg.PlanModeAutoExitOnEndTurn
	}
	// Built-in default: on. See ADR-007 for the on-by-default rationale.
	return true
}

// maybeSynthesizeExitPlanMode is called from the runloop's end_turn /
// stop branch. It checks every precondition for synthesis, fires the
// before_plan_mode_auto_exit hook to let extensions override, and (on
// approval) sets run.exitPlanMode + appends the synthetic
// PermissionDenial so the existing ExitPlanMode wrap-up path emits the
// approval card.
//
// Returns true when synthesis fired (the caller should fall through to
// the ExitPlanMode wrap-up branch). Returns false when synthesis was
// skipped (the caller should proceed with the normal end_turn path).
//
// Synthesis preconditions (all must hold):
//  1. run.planMode is true.
//  2. run.planModeAutoExitEnabled is true.
//  3. assistantBlocks contains NO ExitPlanMode tool_use.
//  4. assistantBlocks contains NO AskUserQuestion tool_use.
//  5. A plan file path is resolvable (run.planFilePath, falling back to
//     hooks.GetSessionPlanFilePath()).
//  6. The before_plan_mode_auto_exit hook did not return Suppress=true.
//
// Logs every decision branch (skip / synthesize / hook-suppress /
// hook-override) at Info or Debug level so the synthesis path is
// reconstructible from ~/.ion/engine.log alone, per the AGENTS.md
// logging policy.
func (b *ApiBackend) maybeSynthesizeExitPlanMode(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	assistantBlocks []types.LlmContentBlock,
	stopReason string,
	turn int,
) bool {
	// Precondition 1: plan mode active.
	if !run.planMode {
		return false
	}
	// Precondition 2: auto-exit enabled by config + RunOptions.
	if !run.planModeAutoExitEnabled {
		utils.Debug("PlanModeAutoExit", fmt.Sprintf(
			"run=%s skip: auto-exit disabled by config/RunOptions",
			run.requestID,
		))
		return false
	}
	// Preconditions 3+4: the assistant didn't call ExitPlanMode or
	// AskUserQuestion. Walk the final assistant turn once and capture
	// the emitted-tool list for the hook payload as we go.
	var emittedTools []string
	var assistantText strings.Builder
	for _, block := range assistantBlocks {
		switch block.Type {
		case "tool_use":
			if block.Name == tools.ExitPlanModeName {
				utils.Debug("PlanModeAutoExit", fmt.Sprintf(
					"run=%s skip: assistant emitted ExitPlanMode (normal exit path)",
					run.requestID,
				))
				return false
			}
			if block.Name == tools.AskUserQuestionName {
				utils.Debug("PlanModeAutoExit", fmt.Sprintf(
					"run=%s skip: assistant emitted AskUserQuestion (user-question path)",
					run.requestID,
				))
				return false
			}
			emittedTools = append(emittedTools, block.Name)
		case "text":
			assistantText.WriteString(block.Text)
		}
	}
	// Precondition 5: a plan file path is resolvable. Prefer the
	// run's own value, fall back to the session-level value (preserved
	// across plan mode toggles). Same resolution pattern as
	// interceptExitPlanMode in runloop_plan_mode_gates.go.
	resolvedPlanFilePath := run.planFilePath
	if resolvedPlanFilePath == "" && hooks.GetSessionPlanFilePath != nil {
		resolvedPlanFilePath = hooks.GetSessionPlanFilePath()
	}
	if resolvedPlanFilePath == "" {
		utils.Warn("PlanModeAutoExit", fmt.Sprintf(
			"run=%s skip: no plan file path resolvable (would emit unactionable approval card)",
			run.requestID,
		))
		return false
	}

	// Precondition 6: fire the before_plan_mode_auto_exit hook. Any
	// handler may suppress (block synthesis) or override the path /
	// reason. The hook payload includes the final assistant text and
	// the list of tools the model did emit this turn, so handlers can
	// implement telemetry that tracks what the model substituted for
	// ExitPlanMode.
	defaultReason := "engine-synthesized: run ended in plan mode without ExitPlanMode call"
	var suppress bool
	var pathOverride, reasonOverride string
	if hooks.OnPlanModeAutoExit != nil {
		sessionID := ""
		if conv != nil {
			sessionID = conv.ID
		}
		// Cap AssistantText at a generous-but-bounded size so a
		// runaway final turn doesn't flood the hook subprocess pipe.
		// The hook is primarily for telemetry; full text is reachable
		// via conversation history if a harness wants it.
		assistantTextStr := assistantText.String()
		const maxHookAssistantText = 4096
		if len(assistantTextStr) > maxHookAssistantText {
			assistantTextStr = assistantTextStr[:maxHookAssistantText]
		}
		suppress, pathOverride, reasonOverride = hooks.OnPlanModeAutoExit(PlanModeAutoExitHookInfo{
			SessionID:     sessionID,
			RunID:         run.requestID,
			StopReason:    stopReason,
			PlanFilePath:  resolvedPlanFilePath,
			AssistantText: assistantTextStr,
			EmittedTools:  emittedTools,
		})
	}
	if suppress {
		utils.Info("PlanModeAutoExit", fmt.Sprintf(
			"run=%s skip: hook suppressed synthesis (conversation parked in plan mode)",
			run.requestID,
		))
		return false
	}
	finalPath := resolvedPlanFilePath
	if pathOverride != "" {
		utils.Info("PlanModeAutoExit", fmt.Sprintf(
			"run=%s hook override: planFilePath %q → %q",
			run.requestID, resolvedPlanFilePath, pathOverride,
		))
		finalPath = pathOverride
	}
	finalReason := defaultReason
	if reasonOverride != "" {
		utils.Info("PlanModeAutoExit", fmt.Sprintf(
			"run=%s hook override: reason %q → %q",
			run.requestID, defaultReason, reasonOverride,
		))
		finalReason = reasonOverride
	}

	// Synthesis fires. Mirror interceptExitPlanMode's mutation
	// pattern (runloop_plan_mode_gates.go:238-245) so the existing
	// ExitPlanMode wrap-up branch in the runloop sees the same state
	// it would have seen if the model had called the tool itself.
	utils.Warn("PlanModeAutoExit", fmt.Sprintf(
		"run=%s synthesized ExitPlanMode: stopReason=%s turn=%d planFile=%s emittedTools=%v",
		run.requestID, stopReason, turn, finalPath, emittedTools,
	))
	run.mu.Lock()
	run.exitPlanMode = true
	run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
		ToolName:  tools.ExitPlanModeName,
		ToolUseID: synthesizedToolUseID(run.requestID, turn),
		ToolInput: map[string]any{
			"planFilePath": finalPath,
			// Mark the denial as engine-synthesized so consumers (and
			// the conversation tree, persisted further down) can
			// distinguish it from a model-driven denial. The field
			// rides in ToolInput rather than a top-level
			// PermissionDenial field to stay additive — the existing
			// PermissionDenial struct is part of the wire contract
			// and growing it would require a coordinated TS/Swift
			// mirror change. Consumers that want the bit reliably
			// should subscribe to PlanModeAutoExitEvent.
			"synthesized": true,
			"reason":      finalReason,
		},
	})
	run.mu.Unlock()

	// Emit PlanModeAutoExitEvent so consumers can distinguish
	// model-driven exits from engine-synthesized ones. Fires BEFORE
	// PlanProposalEvent and TaskCompleteEvent so consumers that key
	// off the synthesis specifically see it first.
	planSlug := types.PlanSlugFromPath(finalPath)
	sessionID := ""
	if conv != nil {
		sessionID = conv.ID
	}
	b.emit(run, types.NormalizedEvent{Data: &types.PlanModeAutoExitEvent{
		SessionID:    sessionID,
		RunID:        run.requestID,
		StopReason:   stopReason,
		PlanFilePath: finalPath,
		PlanSlug:     planSlug,
		Reason:       finalReason,
	}})

	// Emit PlanProposalEvent{Kind:"exit"} as the canonical workflow
	// signal, matching the model-driven path in interceptExitPlanMode.
	// Consumers that already render approval cards from PlanProposal
	// continue to work unchanged.
	b.emit(run, types.NormalizedEvent{Data: &types.PlanProposalEvent{
		Kind:         "exit",
		PlanFilePath: finalPath,
		PlanSlug:     planSlug,
	}})
	return true
}

// synthesizedToolUseID generates a deterministic tool_use ID for a
// synthesized ExitPlanMode denial. The ID never collides with provider-
// issued tool_use IDs because providers use "toolu_..." or "tool_..."
// prefixes; the "synth-exit-plan-..." prefix is unmistakably engine
// origin. The runID + turn suffix lets logs reconstruct which run /
// turn produced the synthesis without searching the conversation tree.
func synthesizedToolUseID(runID string, turn int) string {
	return fmt.Sprintf("synth-exit-plan-%s-t%d-%d", runID, turn, time.Now().UnixNano())
}
