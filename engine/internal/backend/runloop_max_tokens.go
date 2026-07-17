package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// defaultMaxTokenThinkingOnlyBreaker is the built-in cap on consecutive
// max_tokens turns that produce zero non-thinking output before the engine
// terminates the run. Chosen small (3) because a healthy run never produces
// three thinking-only max_tokens turns in a row: the pathology it guards
// against (thinking budget >= MaxTokens) produces them every single turn, so
// three is enough to detect the loop while tolerating a transient truncation.
const defaultMaxTokenThinkingOnlyBreaker = 3

// turnProducedNonThinkingOutput reports whether the assistant blocks for a
// turn contain any real work: a non-empty text block or a tool_use block.
// Pure-thinking turns (only {"type":"thinking"} / "redacted_thinking" blocks,
// or empty text) return false — those are the turns the circuit breaker
// counts toward termination.
func turnProducedNonThinkingOutput(blocks []types.LlmContentBlock) bool {
	for _, block := range blocks {
		switch block.Type {
		case "tool_use":
			return true
		case "text":
			if block.Text != "" {
				return true
			}
		}
	}
	return false
}

// resolveMaxTokenThinkingOnlyBreaker resolves the effective circuit-breaker
// cap for a run: per-run engine config (RunConfig.MaxTokenThinkingOnlyBreaker,
// threaded from engine.json limits) → built-in default (3). A value of -1
// disables the breaker; it is surfaced as MaxInt so the >= comparison never
// trips.
func resolveMaxTokenThinkingOnlyBreaker(run *activeRun) int {
	cap := defaultMaxTokenThinkingOnlyBreaker
	if run.cfg != nil && run.cfg.MaxTokenThinkingOnlyBreaker != 0 {
		cap = run.cfg.MaxTokenThinkingOnlyBreaker
	}
	if cap < 0 {
		// -1 (or any negative) means "disabled": use MaxInt so the count can
		// never reach the cap.
		return int(^uint(0) >> 1)
	}
	return cap
}

// maybeBreakMaxTokenThinkingOnly implements the max_tokens thinking-only
// circuit breaker. It is called from handleMaxTokens BEFORE the
// continuation-injection logic.
//
// Behavior:
//   - If the turn produced any non-thinking output (text or tool_use), the
//     consecutive-thinking-only counter is reset to 0 and the function returns
//     false (the run continues normally — this max_tokens turn was genuine
//     truncation of real output, not the thinking-budget loop).
//   - If the turn produced ONLY thinking, the counter is incremented. When it
//     reaches the resolved cap, the function emits an ErrorEvent + a non-zero
//     emitExit and returns true, signaling the caller to return from runLoop.
//     Otherwise it returns false so the caller falls through to the normal
//     continuation-injection path.
//
// Returning true means "the run has been terminated; the caller must return."
func (b *ApiBackend) maybeBreakMaxTokenThinkingOnly(
	run *activeRun,
	conv *conversation.Conversation,
	assistantBlocks []types.LlmContentBlock,
	turn int,
) bool {
	if turnProducedNonThinkingOutput(assistantBlocks) {
		// Genuine forward progress (or at least real output) this turn — reset
		// the consecutive counter. Log the reset so a reader can see the
		// breaker disarm mid-run.
		if run.maxTokenThinkingOnlyCount != 0 {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "maxTokensBreaker: reset thinking-only counter on non-thinking output", map[string]any{
				"run_id":     run.requestID,
				"turn":       turn,
				"prev_count": run.maxTokenThinkingOnlyCount,
			})
		}
		run.maxTokenThinkingOnlyCount = 0
		return false
	}

	// Pure-thinking max_tokens turn — increment the consecutive counter.
	run.maxTokenThinkingOnlyCount++
	cap := resolveMaxTokenThinkingOnlyBreaker(run)
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "maxTokensBreaker: thinking-only max_tokens turn", map[string]any{
		"run_id":  run.requestID,
		"turn":    turn,
		"count":   run.maxTokenThinkingOnlyCount,
		"cap":     cap,
		"cum_in":  run.cumulativeInputTokens,
		"cum_out": run.cumulativeOutputTokens,
	})

	if run.maxTokenThinkingOnlyCount < cap {
		// Not yet at the cap — let the caller inject a continuation as usual.
		return false
	}

	// Cap reached: the run is stuck producing only thinking output every turn,
	// almost certainly because the resolved thinking budget is >= MaxTokens.
	// Terminate rather than inject another continuation into an infinite loop.
	msg := fmt.Sprintf(
		"max_tokens thinking-only loop: %d consecutive turns produced no output (thinking-budget may exceed max_tokens)",
		run.maxTokenThinkingOnlyCount,
	)
	utils.LogWithFields(utils.LevelError, "backend.runloop", "maxTokensBreaker: TERMINATING run", map[string]any{
		"run_id":     run.requestID,
		"turn":       turn,
		"count":      run.maxTokenThinkingOnlyCount,
		"cap":        cap,
		"cum_in":     run.cumulativeInputTokens,
		"cum_out":    run.cumulativeOutputTokens,
		"model":      conv.Model,
		"session_id": conv.ID,
	})
	b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
		ErrorMessage: msg,
		IsError:      true,
		ErrorCode:    "max_tokens_thinking_only_loop",
	}})
	b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
	return true
}

// handleMaxTokens is the complete body of the run loop's `max_tokens` stop
// case, extracted from runloop.go to keep that file under the size cap. It
// runs the thinking-only circuit breaker first, then — if the run is not
// terminated — injects the appropriate continuation system message
// (truncated-tool advisory or the generic "continue" nudge).
//
// Returns true when the run has been terminated (the breaker fired) and the
// caller must return from runLoop; false when the run should continue looping.
func (b *ApiBackend) handleMaxTokens(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	assistantBlocks []types.LlmContentBlock,
	turn, maxTurns int,
) bool {
	// Circuit breaker for the thinking-budget-exceeds-MaxTokens pathology.
	if b.maybeBreakMaxTokenThinkingOnly(run, conv, assistantBlocks, turn) {
		return true
	}

	// Detect whether a tool_use block was truncated. When the stream is cut
	// mid-tool-call the input JSON is unparseable and gets coerced to {} in
	// processStream. Tell the model what happened so it can retry with a
	// smaller payload or split the work, rather than blindly repeating the same
	// too-large call.
	truncatedTool := ""
	for _, block := range assistantBlocks {
		if block.Type == "tool_use" && len(block.Input) == 0 && block.Name != "" {
			truncatedTool = block.Name
			break
		}
	}

	if truncatedTool != "" {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "max_tokens truncated tool_use", map[string]any{
			"tool":   truncatedTool,
			"run_id": run.requestID,
			"turn":   turn,
		})
		b.injectSystemMessage(run, conv, hooks, opts, "max_token_continue",
			fmt.Sprintf("Your previous response was cut off by the output token limit while generating the input for tool '%s'. The tool call was NOT executed. Break the work into smaller pieces — for example, write the file in multiple parts using Bash with heredocs or sequential Write calls.", truncatedTool),
			turn, maxTurns)
	} else {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "max_tokens reached, continuing", map[string]any{
			"run_id": run.requestID,
			"turn":   turn,
		})
		b.injectSystemMessage(run, conv, hooks, opts, "max_token_continue",
			"Continue from where you left off.",
			turn, maxTurns)
	}
	return false
}
