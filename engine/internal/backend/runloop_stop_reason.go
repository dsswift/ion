package backend

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchStopReason handles the per-turn stop-reason switch extracted from
// runLoop. It runs after the assistant turn has been persisted and the
// turn_end hook has fired. The returned bool tells runLoop whether the run
// is finished: true means runLoop should return (the run terminated — a
// TaskCompleteEvent + exit has already been emitted, or a cancellation was
// handled); false means runLoop should keep iterating (the turn produced
// tool results, an early-stop / steer continuation, or a non-terminal
// max_tokens continuation).
//
// Extracted verbatim from runLoop's inline switch to keep runloop.go under
// the file-size cap. The mapping is mechanical: every `return` in the old
// inline switch became `return true` here, and every `continue` became
// `return false`; the tool_use fall-through (which let the for-loop advance
// to the next turn) is the final `return false`.
func (b *ApiBackend) dispatchStopReason(
	ctx context.Context,
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	earlyStop effectiveEarlyStopConfig,
	assistantBlocks []types.LlmContentBlock,
	stopReason string,
	currentTurnOutputTokens int,
	turn, maxTurns int,
	convDir string,
) bool {
	// Reconcile the provider's stop reason against what the turn actually
	// produced. A provider may report a terminal reason on the same message
	// that carries tool_use blocks — an OpenAI-compatible gateway emitting
	// finish_reason "stop" after streaming tool-call deltas translates to
	// end_turn (translateFinishReason, internal/providers/openai.go) while
	// processStream has already collected a fully-parsed tool_use block.
	//
	// The block payload is authoritative: the engine holds the parsed blocks,
	// so it does not have to trust a reason that contradicts them. Taking the
	// reason at face value here discarded the tool call, emitted
	// TaskCompleteEvent, and ended the run with the requested work never
	// executed — and because the orphaned tool_use never gained a matching
	// tool_result, SanitizeMessages then stripped it from every subsequent
	// provider request, so even a resumed run could not see what was asked.
	//
	// This is the complement of the zero-tool-blocks guard in the "tool_use"
	// case below; the two together mean a stop-reason/payload disagreement is
	// always resolved in favour of the payload, in both directions.
	if stopReason == "end_turn" || stopReason == "stop" {
		toolUseCount := 0
		for _, block := range assistantBlocks {
			if block.Type == "tool_use" {
				toolUseCount++
			}
		}
		if toolUseCount > 0 {
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "terminal stop reason with tool blocks present; executing tools", map[string]any{
				"run_id":      run.requestID,
				"turn":        turn,
				"stop_reason": stopReason,
				"tool_count":  toolUseCount,
			})
			stopReason = "tool_use"
		}
	}

	switch stopReason {
	case "end_turn", "stop":
		// Extract final text for task_complete
		var resultText string
		for _, block := range assistantBlocks {
			if block.Type == "text" {
				resultText += block.Text
			}
		}

		// Keep a running record of the last non-empty result text across all
		// turns. Used to populate TaskCompleteEvent.LastText when the final
		// turn is silent (thinking-only end_turn) so consumers can still
		// recover the last substantive text the run produced.
		if resultText != "" {
			run.lastNonEmptyResultText = resultText
		}

		// Early-stop continuation decision. When the model stops well
		// below the configured token budget the engine injects a
		// "keep working" nudge and re-runs the turn instead of
		// emitting TaskCompleteEvent. Engine-side defaults can be
		// overridden globally (engine.json), per-run (RunOptions), or
		// programmatically (before_early_stop_decision hook). See
		// runloop_early_stop.go for full decision logic.
		if b.maybeContinueEarlyStop(run, conv, hooks, opts, earlyStop, currentTurnOutputTokens, stopReason, turn, maxTurns) {
			// Persist before looping so the injected user message
			// survives a mid-loop crash. Same write semantics as the
			// existing post-assistant-message Save above.
			if err := conversation.Save(conv, ""); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after early-stop continuation", map[string]any{
					"error": utils.ErrStr(err),
				})
			}
			return false
		}

		// Plan-mode auto-exit safety net (issue #187). When the
		// model ends a plan-mode turn without invoking ExitPlanMode
		// or AskUserQuestion, the engine deterministically
		// synthesizes the exit so consumers reliably see the
		// plan-approval card. Returns true only when synthesis
		// fired (all preconditions met and no hook suppressed it);
		// in that case we fall through to a wrap-up branch that
		// emits TaskCompleteEvent carrying the synthesized
		// PermissionDenial, mirroring the model-driven exit path
		// in the tool_use case below. See
		// runloop_plan_mode_auto_exit.go for the precondition list
		// and the resolved-defaults precedence chain.
		if b.maybeSynthesizeExitPlanMode(run, conv, hooks, assistantBlocks, stopReason, turn) {
			if err := conversation.Save(conv, ""); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after plan-mode auto-exit", map[string]any{
					"error": utils.ErrStr(err),
				})
			}
			elapsed := time.Since(run.startTime).Milliseconds()
			run.mu.Lock()
			denials := run.permissionDenials
			run.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "plan mode auto-exited: cost=$ ms", map[string]any{
				"run_id":      run.requestID,
				"turns":       turn,
				"total_cost":  run.totalCost,
				"duration_ms": elapsed,
				"session_id":  conv.ID,
			})
			b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Reason:            types.TaskCompletionReasonNormal,
				Result:            "Plan mode auto-exited.",
				LastText:          run.lastNonEmptyResultText,
				CostUsd:           run.totalCost,
				DurationMs:        elapsed,
				NumTurns:          turn,
				ConversationTurns: conversation.CountUserPrompts(conv),
				SessionID:         conv.ID,
				Usage:             cumulativeUsage(run),
				PermissionDenials: denials,
			}})
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return true
		}

		// A completion may arrive while the model is composing its final
		// response. Persist and inject it before terminalizing, then give the
		// provider a new turn to consume it. Returning completion here would
		// make the durable message invisible until an unrelated future prompt.
		if b.drainCompletedChildDispatches(run, conv) {
			return false
		}

		// Check for a steer message that arrived while the model was
		// streaming its final response. If present, inject it and
		// continue the loop so the model reacts on its next turn
		// rather than the message being treated as a new run by the
		// session layer. This is the critical fix for "steer during
		// end_turn is orphaned."
		if b.drainSteer(run, conv) {
			if err := conversation.Save(conv, ""); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after end_turn steer", map[string]any{
					"error": utils.ErrStr(err),
				})
			}
			return false
		}

		// The model has finished its turn. If the session still has background
		// commands outstanding (Bash run_in_background + notify_on_complete),
		// park instead of completing: the work is not done, it is merely not
		// occupying a turn. The session layer revives the session with a fresh
		// run when a command completes.
		//
		// Ordered AFTER the steer drain deliberately — an in-flight steer is
		// immediate work the model should react to now, whereas parking is for
		// when there is genuinely nothing left to do this turn.
		//
		// An empty outstanding set falls through to the normal completion path
		// below, so a session that never used notify_on_complete behaves
		// exactly as it did before this existed.
		if tasks, polls := b.outstandingBackgroundTaskIDs(run), b.outstandingPollIDs(run); len(tasks) > 0 || len(polls) > 0 {
			b.parkForBackgroundTasks(run, conv, tasks, polls)
			return true
		}

		// Child-dispatch park, ordered after the bash park: if this run (a
		// dispatched agent) still has child dispatches in flight, park in the
		// SUSPEND shape instead of completing. The runChild goroutine that
		// owns this dispatch observes the TaskSuspendEvent, holds the
		// dispatch open as "suspended", and restarts the LLM run when the
		// children complete — so a lead that fire-and-forgets a specialist
		// and ends its turn stays alive to consume the result instead of
		// reporting completion for work still in flight. No exit is emitted
		// here (see parkForChildDispatches for why that differs from the
		// root-session bash park above). Nil seam ⇒ empty set ⇒ this branch
		// never fires (root sessions, pre-existing consumers).
		if outstanding := b.outstandingChildDispatchIDs(run); len(outstanding) > 0 {
			b.parkForChildDispatches(run, conv, outstanding)
			return true
		}
		// Both outstanding sets empty: fall through to normal completion.
		// DEBUG (not silent) so the park decision's negative branch is
		// reconstructible from logs alongside the positive branches above.
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "turn boundary: no outstanding background tasks or child dispatches, completing", map[string]any{
			"run_id": run.requestID,
		})

		// Save conversation
		if err := conversation.Save(conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation", map[string]any{
				"error": utils.ErrStr(err),
			})
		}

		elapsed := time.Since(run.startTime).Milliseconds()
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "run complete: cost=$ ms", map[string]any{
			"run_id":      run.requestID,
			"turns":       turn,
			"total_cost":  run.totalCost,
			"duration_ms": elapsed,
			"session_id":  conv.ID,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
			Reason:            types.TaskCompletionReasonNormal,
			Result:            resultText,
			LastText:          run.lastNonEmptyResultText,
			CostUsd:           run.totalCost,
			DurationMs:        elapsed,
			NumTurns:          turn,
			ConversationTurns: conversation.CountUserPrompts(conv),
			SessionID:         conv.ID,
			Usage:             cumulativeUsage(run),
		}})
		b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
		return true

	case "tool_use":
		// Extract tool_use blocks
		var toolUseBlocks []types.LlmContentBlock
		for _, block := range assistantBlocks {
			if block.Type == "tool_use" {
				toolUseBlocks = append(toolUseBlocks, block)
			}
		}

		if len(toolUseBlocks) == 0 {
			// No tool calls despite tool_use stop reason; treat as end_turn.
			// Complement of the terminal-reason-with-tool-blocks
			// reconciliation at the top of this function: both arms resolve a
			// stop-reason/payload disagreement in favour of the payload. Do
			// not collapse either one — they cover opposite skews.
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "tool_use stop reason with zero tool blocks", map[string]any{
				"run_id": run.requestID,
				"turn":   turn,
			})
			return false
		}

		// Execute tools in parallel
		results, err := b.executeTools(ctx, run, toolUseBlocks, opts.ProjectPath)
		if err != nil {
			if ctx.Err() != nil {
				utils.LogWithFields(utils.LevelWarn, "backend.runloop", "tool execution cancelled", map[string]any{
					"run_id": run.requestID,
				})
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return true
			}
			utils.LogWithFields(utils.LevelError, "backend.runloop", "tool execution failed", map[string]any{
				"run_id": run.requestID,
				"error":  utils.ErrStr(err),
			})
			b.emitError(run, err)
			b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
			return true
		}

		// Check for cancellation even when tools completed successfully.
		// Tool goroutines return nil unconditionally, so executeTools may
		// return (results, nil) even after the context was cancelled.
		// Without this check the loop would add results and start a new
		// LLM turn before noticing the abort at the top of the loop.
		if ctx.Err() != nil {
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "run cancelled after tool execution", map[string]any{
				"run_id": run.requestID,
			})
			b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
			return true
		}

		// If ExitPlanMode was triggered, or a human-wait client tool parked
		// the run, wrap up now. Both terminate the run, but they are
		// DIFFERENT events and must not borrow each other's prose: a parked
		// question is not a plan-mode exit, and claiming so wrote "Plan mode
		// exited." into the transcript of every guided-questions round.
		run.mu.Lock()
		exiting := run.exitPlanMode
		parked := run.parkedHumanWait
		denials := run.permissionDenials
		run.mu.Unlock()
		if exiting || parked {
			if err := conversation.Save(conv, ""); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation", map[string]any{
					"error": utils.ErrStr(err),
				})
			}
			elapsed := time.Since(run.startTime).Milliseconds()
			// Park wins the label when both are set: the park is what ended
			// this run, and plan mode remains whatever it was.
			logMsg := "plan mode exited: cost=$ ms"
			result := "Plan mode exited."
			if parked {
				logMsg = "run parked awaiting user input: cost=$ ms"
				result = "Waiting for the user's answers."
			}
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", logMsg, map[string]any{
				"run_id":      run.requestID,
				"turns":       turn,
				"total_cost":  run.totalCost,
				"duration_ms": elapsed,
				"session_id":  conv.ID,
			})
			b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Reason:            types.TaskCompletionReasonNormal,
				Result:            result,
				LastText:          run.lastNonEmptyResultText,
				CostUsd:           run.totalCost,
				DurationMs:        elapsed,
				NumTurns:          turn,
				ConversationTurns: conversation.CountUserPrompts(conv),
				SessionID:         conv.ID,
				Usage:             cumulativeUsage(run),
				PermissionDenials: denials,
			}})
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return true
		}

		// Apply system-wide tool result size cap. Oversized results
		// (dispatch transcripts, large file reads, verbose command
		// output) are persisted to disk with a preview so the LLM
		// retains access without consuming context window tokens.
		maxToolResultChars := opts.MaxToolResultChars
		if maxToolResultChars == 0 && run.cfg != nil && run.cfg.MaxToolResultChars > 0 {
			maxToolResultChars = run.cfg.MaxToolResultChars
		}
		if convDir != "" && maxToolResultChars >= 0 {
			conversation.AddToolResultsWithSizeCheck(conv, results, convDir, maxToolResultChars)
		} else {
			conversation.AddToolResults(conv, results)
		}
		// Persist immediately so tool history survives mid-multi-turn crashes.
		if err := conversation.Save(conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after AddToolResults", map[string]any{
				"error": utils.ErrStr(err),
			})
		}

		// Consume child completion records before user steering and the next
		// provider turn. This is the active-parent arm of automatic delivery.
		b.drainCompletedChildDispatches(run, conv)

		// Check for a steer message that arrived during tool execution.
		// Injecting it here (rather than waiting for the top-of-loop
		// check) ensures it lands in the conversation before the very
		// next LLM call, minimizing latency.
		b.drainSteer(run, conv)

		// Reset early-stop continuation counters on tool_use: the model
		// is making forward progress through tools, so the next end_turn
		// gets a fresh cap. Without this reset a long multi-tool run
		// (e.g. a 10-step refactor) would consume the continuation
		// budget on tool turns that produce little output text.
		if run.continuationCount != 0 || run.lastContinuationDelta != 0 {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "earlyStop: reset continuation counters on tool_use", map[string]any{
				"run_id":     run.requestID,
				"turn":       turn,
				"prev_count": run.continuationCount,
			})
			run.continuationCount = 0
			run.lastContinuationDelta = 0
		}
		return false

	case "max_tokens":
		// All max_tokens handling — the thinking-only circuit breaker plus
		// the truncated-tool / generic continuation injection — lives in
		// handleMaxTokens (runloop_max_tokens.go). A true return means the
		// run was terminated by the breaker; return from runLoop.
		if b.handleMaxTokens(run, conv, hooks, opts, assistantBlocks, turn, maxTurns) {
			return true
		}
		return false

	default:
		// Non-standard stop reason. Delegate to the helper, which
		// distinguishes a provider "error" (ErrorEvent + non-zero exit)
		// from a genuinely-unknown reason (clean exit 0). See
		// handleUnknownStopReason in runloop_helpers.go.
		b.handleUnknownStopReason(run, conv, stopReason, turn)
		return true
	}
}
