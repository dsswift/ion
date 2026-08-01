package backend

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maxPromptTooLongRetries caps reactive compaction attempts triggered by
// prompt_too_long / overloaded_error responses before giving up on the run.
const maxPromptTooLongRetries = 3

// performCompactParams bundles every input performCompact needs. Built once
// per call site so the function signature stays stable as new compaction
// inputs land (e.g. a "trigger" string when we added user-triggered compaction).
//
// Fields:
//   - ctx:           Threaded for LLM-based summarisation (tier 2 of the
//     four-tier fallback). May be context.Background() for
//     out-of-run callers; the LLM tier respects cancellation
//     on its own deadline if the ctx has none.
//   - run:           Synthetic-or-real activeRun. b.emit reads run.requestID
//     for routing and updates run.lastProgressAt. Must not be
//     nil — CompactNow constructs a minimal one when invoked
//     outside an actual run loop.
//   - conv:          The conversation to compact in place.
//   - hooks:         Per-run hooks (cancel, summary override, memory access).
//     Zero-valued RunHooks{} is fine; nil callbacks are skipped.
//   - contextWindow: Total context budget for the active model (tokens).
//   - tokenLimit:    Pre-compaction trigger threshold. Used only for logging
//     and the hook payload; performCompact does not re-check
//     it (the caller has already decided compaction must run).
//   - cp:            Compaction policy knobs from RunOptions.
//   - trigger:       "auto" (proactive), "reactive" (prompt_too_long retry),
//     or "user" (operator-initiated /compact). Surfaced on the
//     boundary block's Trigger field and the CompactingEvent
//     Strategy field so consumers can distinguish the path.
type performCompactParams struct {
	ctx           context.Context
	run           *activeRun
	conv          *conversation.Conversation
	hooks         RunHooks
	contextWindow int
	tokenLimit    int
	cp            compactParams
	trigger       string
}

// performCompact runs the compaction pipeline: micro-compact → optional
// hard-truncate with four-tier summary → boundary-block injection → tree
// entry append → save → memory-tracking reset → session_compact hook.
//
// Extracted from compactIfNeeded so the same code path serves three
// triggers: the proactive token-limit check (via compactIfNeeded),
// the reactive prompt_too_long retry (via compactReactive — though
// that path stays separate because of escalation semantics), and
// out-of-run user-initiated compaction (via CompactNow). Sharing the
// implementation guarantees byte-identical observability: the
// boundary block shape, event sequence, hook payloads, and tree
// entries do not drift based on which trigger fired.
//
// Caller responsibilities — performCompact assumes these have already
// happened:
//   - Decision to compact (token-limit check, prompt_too_long signal,
//     or user request) — performCompact ALWAYS compacts.
//   - session_before_compact hook (cancellation gate) — fired by
//     compactIfNeeded for "auto" and by CompactNow for "user". The
//     reactive path has its own copy and bypasses performCompact
//     entirely (see compactReactive).
//   - run.compactionsWithoutProgress increment (only the proactive
//     gate cares about the cascade circuit breaker; user-triggered
//     compaction skips it because the user is explicitly asking).
//
// The function is intentionally not in compactIfNeeded's gate so a
// reviewer can see the pure "do the compaction" sequence in one
// place. Diff against the original compactIfNeeded body for the
// extraction's equivalence proof.

// compactIfNeeded performs proactive compaction when context usage exceeds
// the absolute token limit. Honours the session_before_compact hook (which
// can cancel the operation) and emits CompactingEvent edges so consumers
// can mirror progress. The session_compact observer hook fires on completion.
//
// tokenLimit is the absolute token count above which compaction should fire
// (see conversation.AutoCompactTokenLimit for how this is derived from the
// raw context window).
//
// A per-run counter bounds consecutive attempts: if the conversation cannot
// be shrunk below the limit in maxConsecutiveCompactions attempts, the run
// emits an ErrorEvent with code compact_loop_aborted and stops trying
// proactively. The counter resets on any successful API response.
//
// ctx is threaded for LLM-based summarisation (tier 2 of the four-tier
// summary fallback: session memory → LLM → hook → regex).
func (b *ApiBackend) compactIfNeeded(ctx context.Context, run *activeRun, conv *conversation.Conversation, hooks RunHooks, contextWindow, tokenLimit int, cp compactParams) {
	// Gate: skip proactive compaction when explicitly disabled.
	if run.opts != nil && run.opts.CompactEnabled != nil && !*run.opts.CompactEnabled {
		utils.Debug("ApiBackend", "compactIfNeeded: auto-compact disabled by config")
		return
	}

	usage := conversation.GetContextUsage(conv, contextWindow)
	if usage.Tokens <= tokenLimit {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compactIfNeeded: no compaction needed %", map[string]any{
			"tokens":    usage.Tokens,
			"limit":     tokenLimit,
			"pct":       usage.Percent,
			"estimated": usage.Estimated,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compactIfNeeded: compaction needed %", map[string]any{
		"tokens":         usage.Tokens,
		"limit":          tokenLimit,
		"pct":            usage.Percent,
		"estimated":      usage.Estimated,
		"context_window": contextWindow,
	})

	// Circuit breaker: stop attempting if we have already compacted
	// maxConsecutiveCompactions times without a successful API response.
	// Without this guard the same trigger condition can fire every turn
	// indefinitely.
	if run.compactionsWithoutProgress >= maxConsecutiveCompactions {
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "compact_loop_aborted: consecutive compactions did not bring tokens below limit", map[string]any{
			"compactions_without_progress": run.compactionsWithoutProgress,
			"tokens":                       usage.Tokens,
			"token_limit":                  tokenLimit,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf(
				"compaction loop aborted after %d attempts without progress (tokens=%d, limit=%d)",
				run.compactionsWithoutProgress, usage.Tokens, tokenLimit),
			IsError:   true,
			ErrorCode: "compact_loop_aborted",
		}})
		return
	}

	// Fire session_before_compact hook (can cancel)
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compactIfNeeded: proactive compaction cancelled by OnSessionBeforeCompact hook", map[string]any{
			"request_id": run.requestID,
		})
		return
	}

	utils.LogWithFields(utils.LevelDebug, "backend.compaction", "incrementing compactions without progress", map[string]any{
		"count": run.compactionsWithoutProgress,
		"max":   run.compactionsWithoutProgress + 1,
	})
	run.compactionsWithoutProgress++

	if err := b.performCompact(performCompactParams{
		ctx:           ctx,
		run:           run,
		conv:          conv,
		hooks:         hooks,
		contextWindow: contextWindow,
		tokenLimit:    tokenLimit,
		cp:            cp,
		trigger:       "auto",
	}); err != nil {
		utils.LogWithFields(utils.LevelError, "backend.runloop", "proactive compaction failed", map[string]any{"run_id": run.requestID, "error": err.Error()})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{ErrorMessage: err.Error(), IsError: true, ErrorCode: "compaction_failed"}})
	}
}

// compactReactive runs the 3-step reactive compaction triggered by a
// prompt_too_long / overloaded provider error. attempt is 1-based; the caller
// passes the post-increment value so the token budget shrinks progressively
// on each retry (targetPercent / attempt). Returns true if compaction ran,
// false when the session_before_compact hook cancelled it (the caller should
// still retry the turn as-is in that case).
//
// ctx is threaded for LLM-based summarisation (tier 2 of the four-tier
// summary fallback: session memory → LLM → hook → regex).
func (b *ApiBackend) compactReactive(ctx context.Context, run *activeRun, conv *conversation.Conversation, hooks RunHooks, contextWindow, attempt int, cp compactParams) bool {
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compactReactive: entry", map[string]any{
		"context_window": contextWindow, "attempt": attempt, "target_percent": cp.targetPercent,
	})
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.Log("ApiBackend", "reactive compaction cancelled by hook")
		return false
	}
	if attempt <= 0 {
		attempt = 1
	}
	escalated := cp
	escalated.targetPercent = cp.targetPercent / float64(attempt)
	// tokenLimit=-1 forces the shared executor's hard-truncate path. Reactive
	// compaction is already provider-triggered, so no proactive gate applies.
	if err := b.performCompact(performCompactParams{
		ctx: ctx, run: run, conv: conv, hooks: hooks, contextWindow: contextWindow,
		tokenLimit: -1, cp: escalated, trigger: "reactive",
	}); err != nil {
		utils.LogWithFields(utils.LevelError, "backend.runloop", "reactive compaction failed", map[string]any{
			"run_id": run.requestID, "attempt": attempt, "error": err.Error(),
		})
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{ErrorMessage: err.Error(), IsError: true, ErrorCode: "compaction_failed"}})
	}
	return true
}

// renderCompactSummary picks the rendering path for the boundary block's
// Summary field. It handles only the hook → regex tail of the four-tier
// summary fallback ladder (session memory → LLM → hook → regex): the
// session-memory and LLM tiers run in the runloop above this call site
// because they have their own engine-internal side effects (memory
// lookup, provider usage event emission) that don't belong inside a
// pure-decision helper.
//
// When the harness wired RunHooks.OnRequestCompactSummary and that hook
// returned a non-empty string, the hook's output wins. Else the engine
// falls back to its regex pipeline: FormatFactsSummary(facts).
//
// Returns (summary, path) where path is "hook" | "regex" | "empty" for
// log correlation. An empty summary is a valid return — the caller still
// injects the boundary block so the conversation has a structural anchor
// to slice at on the next pass.
func renderCompactSummary(runID string, hooks RunHooks, strategy string, scanSlice []types.LlmMessage, facts []compaction.Fact) (string, string) {
	if hooks.OnRequestCompactSummary != nil {
		if hookSummary, ok := hooks.OnRequestCompactSummary(runID, strategy, scanSlice); ok && hookSummary != "" {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "renderCompactSummary: path=hook", map[string]any{
				"strategy":    strategy,
				"summary_len": len(hookSummary),
				"count":       len(scanSlice),
			})
			return hookSummary, "hook"
		}
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "renderCompactSummary: hook present but returned empty, falling back to regex", map[string]any{
			"strategy": strategy,
		})
	}
	if len(facts) == 0 {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "renderCompactSummary: path=empty (no facts, no hook)", map[string]any{
			"strategy": strategy,
		})
		return "", "empty"
	}
	regex := compaction.FormatFactsSummary(facts)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "renderCompactSummary: path=regex", map[string]any{
		"strategy":    strategy,
		"summary_len": len(regex),
		"fact_count":  len(facts),
	})
	return regex, "regex"
}
