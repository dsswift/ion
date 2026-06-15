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

// compactParams holds the configurable compaction parameters extracted from
// RunOptions. Passed to compactIfNeeded / compactReactive so the compaction
// logic reads policy from config rather than hardcoding values.
type compactParams struct {
	targetPercent     float64
	microKeepTurns    int
	minKeepTurns      int
	estimationPadding float64
	summaryEnabled    bool
	summaryModel      string
	summaryMaxTokens  int
	memoryEnabled     bool
	convDir           string // directory for .tree.jsonl path injection

	// getSessionMemory returns the current session memory content (if any).
	// Set by the session layer via RunConfig.GetSessionMemory. Nil means
	// session memory is not available — the compaction flow skips to the
	// next tier (LLM summary or regex facts).
	getSessionMemory func() string

	// getLastSummarizedEntryID returns the entry ID boundary of the most
	// recent session memory summary. Used to determine whether the memory
	// actually covers the messages being dropped during compaction.
	getLastSummarizedEntryID func() string

	// resetMemoryTracking resets the session memory debounce baselines
	// to the given token count. Called after compaction completes so the
	// growth threshold restarts from the post-compaction level.
	resetMemoryTracking func(tokens int)
}

// buildCompactParams extracts compaction knobs from RunOptions, applying
// defaults from the conversation package for any field the caller didn't set.
func buildCompactParams(opts *types.RunOptions, convDir string) compactParams {
	p := compactParams{
		targetPercent:     conversation.DefaultTargetPercent,
		microKeepTurns:    conversation.DefaultMicroCompactKeep,
		minKeepTurns:      conversation.DefaultMinKeepTurns,
		estimationPadding: conversation.DefaultEstimationPadding,
		summaryEnabled:    true,
		convDir:           convDir,
	}
	if opts.CompactTargetPercent > 0 {
		p.targetPercent = opts.CompactTargetPercent
	}
	if opts.CompactMicroKeepTurns > 0 {
		p.microKeepTurns = opts.CompactMicroKeepTurns
	}
	if opts.CompactMinKeepTurns > 0 {
		p.minKeepTurns = opts.CompactMinKeepTurns
	}
	if opts.CompactEstimationPadding > 0 {
		p.estimationPadding = opts.CompactEstimationPadding
	}
	if opts.CompactSummaryEnabled != nil && !*opts.CompactSummaryEnabled {
		p.summaryEnabled = false
	}
	if opts.CompactSummaryModel != "" {
		p.summaryModel = opts.CompactSummaryModel
	}
	if opts.CompactSummaryMaxTokens > 0 {
		p.summaryMaxTokens = opts.CompactSummaryMaxTokens
	}
	if opts.CompactMemoryEnabled != nil {
		p.memoryEnabled = *opts.CompactMemoryEnabled
	}
	utils.Log("ApiBackend", fmt.Sprintf("buildCompactParams: targetPercent=%.1f microKeepTurns=%d minKeepTurns=%d estimationPadding=%.2f summaryEnabled=%v summaryModel=%q memoryEnabled=%v",
		p.targetPercent, p.microKeepTurns, p.minKeepTurns, p.estimationPadding, p.summaryEnabled, p.summaryModel, p.memoryEnabled))
	return p
}

// isMemoryCurrent checks whether the session memory covers the messages
// that compaction will drop. It walks the conversation entries backwards
// from the leaf to find the boundary entry ID. If the boundary is found
// in the entry list, the memory covers everything up to that point.
// Returns false when the boundary is empty, not found, or the entries
// list is nil (no coverage information available).
func isMemoryCurrent(conv *conversation.Conversation, boundaryEntryID string) bool {
	if boundaryEntryID == "" || conv.Entries == nil || len(conv.Entries) == 0 {
		utils.Debug("ApiBackend", fmt.Sprintf("isMemoryCurrent: no boundary or entries (boundary=%q entries=%d)",
			boundaryEntryID, len(conv.Entries)))
		return false
	}

	// Find the boundary entry's position in the entry list.
	boundaryIdx := -1
	for i, e := range conv.Entries {
		if e.ID == boundaryEntryID {
			boundaryIdx = i
			break
		}
	}
	if boundaryIdx < 0 {
		utils.Debug("ApiBackend", fmt.Sprintf("isMemoryCurrent: boundary entry %s not found in %d entries", boundaryEntryID, len(conv.Entries)))
		return false
	}

	// The memory is current if the boundary entry is in the latter half
	// of the entry list (i.e., the memory covers most of the conversation).
	// If the boundary is in the first half, the memory is stale — it only
	// covers content that was already dropped or is about to be dropped.
	midpoint := len(conv.Entries) / 2
	isCurrent := boundaryIdx >= midpoint
	utils.Debug("ApiBackend", fmt.Sprintf("isMemoryCurrent: boundary=%s at idx=%d midpoint=%d totalEntries=%d → current=%v",
		boundaryEntryID, boundaryIdx, midpoint, len(conv.Entries), isCurrent))
	return isCurrent
}

// resolveSessionMemory checks whether the session memory is available and
// covers the current conversation state. Returns the memory content and
// a log reason string. Returns ("", "") when memory should not be used.
func (cp *compactParams) resolveSessionMemory(conv *conversation.Conversation, label string) (summary string, logReason string) {
	if cp.getSessionMemory == nil {
		return "", ""
	}
	mem := cp.getSessionMemory()
	if mem == "" {
		return "", ""
	}
	// Validate that the memory actually covers the messages being
	// dropped. If the boundary entry is stale (deep in already-
	// dropped content), fall through to a fresh LLM summary.
	if cp.getLastSummarizedEntryID != nil {
		entryID := cp.getLastSummarizedEntryID()
		if entryID != "" && isMemoryCurrent(conv, entryID) {
			return mem, fmt.Sprintf("%s compact: using session memory as summary (boundary=%s)", label, entryID)
		}
		utils.Log("ApiBackend", fmt.Sprintf("%s compact: session memory exists but doesn't cover recent messages (boundary=%q), falling through to LLM summary", label, entryID))
		return "", ""
	}
	// No boundary tracking available — use memory as-is for
	// backward compatibility with sessions that predate the
	// boundary tracking feature.
	return mem, fmt.Sprintf("%s compact: using session memory as summary (no boundary tracking)", label)
}

// performCompactParams bundles every input performCompact needs. Built once
// per call site so the function signature stays stable as new compaction
// inputs land (e.g. a "trigger" string when we added user-triggered compaction).
//
// Fields:
//   - ctx:           Threaded for LLM-based summarisation (tier 2 of the
//                    four-tier fallback). May be context.Background() for
//                    out-of-run callers; the LLM tier respects cancellation
//                    on its own deadline if the ctx has none.
//   - run:           Synthetic-or-real activeRun. b.emit reads run.requestID
//                    for routing and updates run.lastProgressAt. Must not be
//                    nil — CompactNow constructs a minimal one when invoked
//                    outside an actual run loop.
//   - conv:          The conversation to compact in place.
//   - hooks:         Per-run hooks (cancel, summary override, memory access).
//                    Zero-valued RunHooks{} is fine; nil callbacks are skipped.
//   - contextWindow: Total context budget for the active model (tokens).
//   - tokenLimit:    Pre-compaction trigger threshold. Used only for logging
//                    and the hook payload; performCompact does not re-check
//                    it (the caller has already decided compaction must run).
//   - cp:            Compaction policy knobs from RunOptions.
//   - trigger:       "auto" (proactive), "reactive" (prompt_too_long retry),
//                    or "user" (operator-initiated /compact). Surfaced on the
//                    boundary block's Trigger field and the CompactingEvent
//                    Strategy field so consumers can distinguish the path.
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
func (b *ApiBackend) performCompact(p performCompactParams) {
	b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	msgBefore := len(p.conv.Messages)

	// usageBefore captures the pre-compaction token count for the
	// hook payload and the boundary block's TokensBefore field.
	// Sourced from GetContextUsage so cache-aware token math is used
	// consistently with the proactive trigger's measurement.
	usageBefore := conversation.GetContextUsage(p.conv, p.contextWindow)
	tokensBefore := usageBefore.Tokens

	// Slice at the most recent boundary so the fact extractor cannot
	// re-extract from a prior summary. Combined with the structural
	// boundary block this is the duplication firewall: previous
	// summaries stay in-context for the model to see, but they are
	// invisible to the regex pipeline that builds the next summary.
	scanSlice := conversation.MessagesAfterLastCompactBoundary(p.conv)
	facts := compaction.ExtractFacts(scanSlice)
	utils.Log("ApiBackend", fmt.Sprintf("%s compact: extracted %d facts from %d-message scan slice (full conv=%d)", p.trigger, len(facts), len(scanSlice), msgBefore))

	// Step 1: MicroCompact — protect only the most recent N turns (default 3).
	cleared := conversation.MicroCompact(p.conv, p.cp.microKeepTurns)
	utils.Log("ApiBackend", fmt.Sprintf("%s compact step 1: tokens=%d limit=%d micro-compact cleared %d (keepTurns=%d)", p.trigger, tokensBefore, p.tokenLimit, cleared, p.cp.microKeepTurns))

	// Step 2: If still above the limit, hard-truncate to a token budget.
	// For "user" trigger we ALWAYS run step 2 regardless of the
	// micro-compact outcome — the user is asking for context reduction
	// and the gentle step is rarely enough on its own. For "auto" we
	// honour the same usage re-check the original compactIfNeeded did,
	// preserving the "step 1 was sufficient" early-exit.
	var summary string
	var sessionMemory string
	targetTokens := int(float64(p.contextWindow) * p.cp.targetPercent / 100.0)
	utils.Debug("ApiBackend", fmt.Sprintf("%s compact: targetTokens formula: contextWindow=%d * targetPercent=%.1f%% = target=%d", p.trigger, p.contextWindow, p.cp.targetPercent, targetTokens))
	usageAfterMicro := conversation.GetContextUsage(p.conv, p.contextWindow)
	utils.Debug("ApiBackend", fmt.Sprintf("%s compact: usageAfterMicro.Tokens=%d (limit=%d)", p.trigger, usageAfterMicro.Tokens, p.tokenLimit))

	shouldHardTruncate := usageAfterMicro.Tokens > p.tokenLimit || p.trigger == "user"
	if shouldHardTruncate {
		// Four-tier summary fallback: session memory → LLM → hook → regex.
		// Must generate summary BEFORE truncation drops the messages.
		if mem, reason := p.cp.resolveSessionMemory(p.conv, p.trigger); mem != "" {
			summary = mem
			sessionMemory = mem
			utils.Log("ApiBackend", reason)
		}
		if summary == "" && p.cp.summaryEnabled {
			droppedText := compaction.FormatMessagesForSummary(p.conv.Messages)
			if droppedText != "" {
				llmSummary, llmUsage := compaction.Summarize(p.ctx, droppedText, p.cp.summaryModel, p.cp.summaryMaxTokens)
				if llmSummary != "" {
					summary = llmSummary
					utils.Log("ApiBackend", fmt.Sprintf("%s compact: LLM summary generated (%d chars)", p.trigger, len(summary)))
					if llmUsage != nil {
						totalIn := llmUsage.InputTokens + llmUsage.CacheReadInputTokens + llmUsage.CacheCreationInputTokens
						b.emit(p.run, types.NormalizedEvent{Data: &types.UsageEvent{
							Usage: types.UsageData{
								InputTokens:  &totalIn,
								OutputTokens: &llmUsage.OutputTokens,
							},
						}})
					}
				} else {
					utils.Log("ApiBackend", fmt.Sprintf("%s compact: LLM summary returned empty despite droppedText len=%d", p.trigger, len(droppedText)))
				}
			} else {
				utils.Debug("ApiBackend", fmt.Sprintf("%s compact: no text content for LLM summary", p.trigger))
			}
		}
		// Tiers 3+4 (hook → regex) live in renderCompactSummary so both
		// compactIfNeeded and compactReactive route through the same
		// decision point. Tiers 1+2 (session memory, LLM) stay above
		// because each has its own engine-internal side effects.
		if summary == "" {
			var path string
			summary, path = renderCompactSummary(p.run.requestID, p.hooks, p.trigger, scanSlice, facts)
			if summary == "" {
				utils.Log("ApiBackend", fmt.Sprintf("%s compact: all four summary tiers produced nothing (session memory, LLM, hook, regex) path=%s", p.trigger, path))
			}
		}

		// Now truncate.
		conversation.CompactToTokenBudget(p.conv, targetTokens, p.cp.minKeepTurns, p.cp.estimationPadding)
		utils.Log("ApiBackend", fmt.Sprintf("%s compact step 2: truncated to budget=%d (%.0f%% of %d), %d messages remain", p.trigger, targetTokens, p.cp.targetPercent, p.contextWindow, len(p.conv.Messages)))

		// Inject a typed boundary block so the next compaction can slice
		// at this point and avoid re-extracting facts from this summary.
		recentFiles := compaction.ExtractRecentFiles(conversation.MessagesAfterLastCompactBoundary(p.conv))
		utils.Debug("ApiBackend", fmt.Sprintf("%s compact: extracted %d recent files", p.trigger, len(recentFiles)))
		injectCompactBoundary(p.conv, conversation.CompactMeta{
			Trigger:            p.trigger,
			MessagesSummarized: msgBefore - len(p.conv.Messages),
			MessagesBefore:     msgBefore,
			MessagesAfter:      len(p.conv.Messages) + 1, // +1 for the boundary about to be inserted
			ClearedBlocks:      cleared,
			TokensBefore:       tokensBefore,
			Summary:            summary,
			FactCount:          len(facts),
			RecentFiles:        recentFiles,
		})
	} else {
		targetTokens = 0
		utils.Debug("ApiBackend", fmt.Sprintf("%s compact: step 1 sufficient, skipping hard truncate (tokens=%d limit=%d)", p.trigger, usageAfterMicro.Tokens, p.tokenLimit))
	}
	conversation.PostCompactReset(p.conv)

	// Emit enriched completion event so clients can render a compaction marker.
	msgAfter := len(p.conv.Messages)
	b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{
		Active:         false,
		Summary:        summary,
		MessagesBefore: msgBefore,
		MessagesAfter:  msgAfter,
		ClearedBlocks:  cleared,
		Strategy:       p.trigger,
	}})

	// Record compaction in the conversation tree (if entries are tracked).
	if p.conv.Entries != nil {
		conversation.AppendEntry(p.conv, conversation.EntryCompaction, conversation.CompactionData{
			Summary:          summary,
			FirstKeptEntryID: firstEntryID(p.conv),
			TokensBefore:     tokensBefore,
		})
		utils.Debug("ApiBackend", fmt.Sprintf("%s compact: appended compaction entry to conversation tree", p.trigger))
	} else {
		utils.Debug("ApiBackend", fmt.Sprintf("%s compact: conv.Entries is nil, skipping tree entry", p.trigger))
	}

	// Persist immediately so compaction survives mid-loop crashes.
	if err := conversation.Save(p.conv, ""); err != nil {
		utils.Log("ApiBackend", fmt.Sprintf("%s compact: failed to save: %s", p.trigger, err.Error()))
	} else {
		utils.Debug("ApiBackend", fmt.Sprintf("%s compact: conversation saved successfully convID=%s", p.trigger, p.conv.ID))
	}

	// Reset session memory debounce baselines so the growth threshold
	// restarts from the post-compaction token count. Without this, the
	// threshold is unreachable because compaction reduced the token count
	// below the previous baseline.
	if p.cp.resetMemoryTracking != nil {
		postTokens := conversation.EstimateTokens(p.conv.Messages)
		p.cp.resetMemoryTracking(postTokens)
	}

	utils.Log("ApiBackend", fmt.Sprintf("%s compact COMPLETE: tokensBefore=%d msgsBefore=%d msgsAfter=%d dropped=%d summaryLen=%d clearedBlocks=%d convID=%s contextWindow=%d",
		p.trigger, tokensBefore, msgBefore, msgAfter, msgBefore-msgAfter, len(summary), cleared, p.conv.ID, p.contextWindow))

	if p.hooks.OnSessionCompact != nil {
		// Compute post-compaction token count before the hook fires.
		tokensAfter := conversation.GetContextUsage(p.conv, p.contextWindow).Tokens

		// Pass facts as a typed slice value on the map payload. The session
		// bridge in prompt_runconfig.go downcasts it directly — no
		// stringly-typed intermediate. nil is fine; the bridge handles
		// missing/empty facts symmetrically.
		p.hooks.OnSessionCompact(p.run.requestID, map[string]interface{}{
			"strategy":         p.trigger,
			"messagesBefore":   msgBefore,
			"messagesAfter":    msgAfter,
			"facts":            facts,
			"tokensBefore":     tokensBefore,
			"tokenLimit":       p.tokenLimit,
			"targetTokens":     targetTokens,
			"microCompactKeep": p.cp.microKeepTurns,
			"tokensAfter":      tokensAfter,
			"sessionMemory":    sessionMemory,
		})
	}
}

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
		utils.Debug("ApiBackend", fmt.Sprintf("compactIfNeeded: no compaction needed tokens=%d limit=%d pct=%d%% estimated=%v", usage.Tokens, tokenLimit, usage.Percent, usage.Estimated))
		return
	}
	utils.Log("ApiBackend", fmt.Sprintf("compactIfNeeded: compaction needed tokens=%d limit=%d pct=%d%% estimated=%v contextWindow=%d", usage.Tokens, tokenLimit, usage.Percent, usage.Estimated, contextWindow))

	// Circuit breaker: stop attempting if we have already compacted
	// maxConsecutiveCompactions times without a successful API response.
	// Without this guard the same trigger condition can fire every turn
	// indefinitely.
	if run.compactionsWithoutProgress >= maxConsecutiveCompactions {
		utils.Warn("ApiBackend", fmt.Sprintf(
			"compact_loop_aborted: %d consecutive compactions did not bring tokens (%d) below limit (%d)",
			run.compactionsWithoutProgress, usage.Tokens, tokenLimit))
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
		utils.Log("ApiBackend", fmt.Sprintf("compactIfNeeded: proactive compaction cancelled by OnSessionBeforeCompact hook requestID=%s", run.requestID))
		return
	}

	utils.Debug("ApiBackend", fmt.Sprintf("compactIfNeeded: compactionsWithoutProgress %d -> %d", run.compactionsWithoutProgress, run.compactionsWithoutProgress+1))
	run.compactionsWithoutProgress++

	b.performCompact(performCompactParams{
		ctx:           ctx,
		run:           run,
		conv:          conv,
		hooks:         hooks,
		contextWindow: contextWindow,
		tokenLimit:    tokenLimit,
		cp:            cp,
		trigger:       "auto",
	})
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
	utils.Log("ApiBackend", fmt.Sprintf("compactReactive: entry contextWindow=%d attempt=%d targetPercent=%.1f microKeepTurns=%d minKeepTurns=%d summaryEnabled=%v memoryEnabled=%v",
		contextWindow, attempt, cp.targetPercent, cp.microKeepTurns, cp.minKeepTurns, cp.summaryEnabled, cp.memoryEnabled))
	// Fire session_before_compact hook (can cancel)
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.Log("ApiBackend", "reactive compaction cancelled by hook")
		return false
	}

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long, compaction attempt %d/%d", attempt, maxPromptTooLongRetries))
	msgBefore := len(conv.Messages)

	// Capture pre-compaction token count for the hook payload.
	usageBefore := conversation.GetContextUsage(conv, contextWindow)
	tokensBefore := usageBefore.Tokens

	// Same duplication firewall as compactIfNeeded — see comment there.
	scanSlice := conversation.MessagesAfterLastCompactBoundary(conv)
	facts := compaction.ExtractFacts(scanSlice)
	utils.Log("ApiBackend", fmt.Sprintf("reactive compact: extracted %d facts from %d-message scan slice (full conv=%d)", len(facts), len(scanSlice), msgBefore))

	// Step 1: micro-compact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, cp.microKeepTurns)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long micro-compact cleared %d blocks (keepTurns=%d)", cleared, cp.microKeepTurns))
	usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
	utils.Debug("ApiBackend", fmt.Sprintf("compactReactive: tokens after micro-compact=%d (pct=%d%%)", usageAfterMicro.Tokens, usageAfterMicro.Percent))

	// Step 2: Four-tier summary fallback: session memory → LLM → hook → regex.
	// Must generate summary BEFORE step 3 truncation drops the messages.
	var summary string
	var sessionMemory string
	if mem, reason := cp.resolveSessionMemory(conv, "reactive"); mem != "" {
		summary = mem
		sessionMemory = mem
		utils.Log("ApiBackend", reason)
	}
	if summary == "" && cp.summaryEnabled {
		droppedText := compaction.FormatMessagesForSummary(conv.Messages)
		if droppedText != "" {
			llmSummary, llmUsage := compaction.Summarize(ctx, droppedText, cp.summaryModel, cp.summaryMaxTokens)
			if llmSummary != "" {
				summary = llmSummary
				utils.Log("ApiBackend", fmt.Sprintf("reactive compact: LLM summary generated (%d chars)", len(summary)))
				if llmUsage != nil {
					totalIn := llmUsage.InputTokens + llmUsage.CacheReadInputTokens + llmUsage.CacheCreationInputTokens
					b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
						Usage: types.UsageData{
							InputTokens:  &totalIn,
							OutputTokens: &llmUsage.OutputTokens,
						},
					}})
				}
			} else {
				utils.Log("ApiBackend", fmt.Sprintf("reactive compact: LLM summary returned empty despite droppedText len=%d", len(droppedText)))
			}
		} else {
			utils.Debug("ApiBackend", "reactive compact: no text content for LLM summary")
		}
	}
	// Tiers 3+4 (hook → regex) live in renderCompactSummary so both
	// compactIfNeeded and compactReactive route through the same
	// decision point. Tiers 1+2 (session memory, LLM) stay above
	// because each has its own engine-internal side effects.
	if summary == "" {
		var path string
		summary, path = renderCompactSummary(run.requestID, hooks, "reactive", scanSlice, facts)
		if summary == "" {
			utils.Debug("ApiBackend", fmt.Sprintf("reactive compact: no summary generated (no facts, no LLM, no hook, no session memory) path=%s", path))
		}
	}

	// Step 3: hard truncate using progressively smaller token budget on each retry.
	escalatedPercent := cp.targetPercent / float64(attempt)
	utils.Debug("ApiBackend", fmt.Sprintf("compactReactive: escalatedPercent=%.1f%% (targetPercent=%.1f / attempt=%d)", escalatedPercent, cp.targetPercent, attempt))
	targetTokens := int(float64(contextWindow) * escalatedPercent / 100.0)
	conversation.CompactToTokenBudget(conv, targetTokens, cp.minKeepTurns, cp.estimationPadding)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long hard-truncated to budget=%d (%.0f%% of %d), %d messages remain",
		targetTokens, escalatedPercent, contextWindow, len(conv.Messages)))

	// Inject a typed boundary block so the next compaction can slice
	// at this point and avoid re-extracting facts from this summary.
	recentFiles := compaction.ExtractRecentFiles(conversation.MessagesAfterLastCompactBoundary(conv))
	utils.Debug("ApiBackend", fmt.Sprintf("compactReactive: extracted %d recent files", len(recentFiles)))
	injectCompactBoundary(conv, conversation.CompactMeta{
		Trigger:            "reactive",
		MessagesSummarized: msgBefore - len(conv.Messages),
		MessagesBefore:     msgBefore,
		MessagesAfter:      len(conv.Messages) + 1,
		ClearedBlocks:      cleared,
		TokensBefore:       tokensBefore,
		Summary:            summary,
		FactCount:          len(facts),
		RecentFiles:        recentFiles,
	})
	conversation.PostCompactReset(conv)

	// Emit enriched completion event so clients can render a compaction marker.
	msgAfter := len(conv.Messages)
	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{
		Active:         false,
		Summary:        summary,
		MessagesBefore: msgBefore,
		MessagesAfter:  msgAfter,
		ClearedBlocks:  cleared,
		Strategy:       "reactive",
	}})

	// Record compaction in the conversation tree (if entries are tracked).
	if conv.Entries != nil {
		conversation.AppendEntry(conv, conversation.EntryCompaction, conversation.CompactionData{
			Summary:          summary,
			FirstKeptEntryID: firstEntryID(conv),
			TokensBefore:     tokensBefore,
		})
		utils.Debug("ApiBackend", "compactReactive: appended compaction entry to conversation tree")
	} else {
		utils.Debug("ApiBackend", "compactReactive: conv.Entries is nil, skipping tree entry")
	}

	// Persist immediately so compaction survives mid-loop crashes.
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save after reactive compaction: "+err.Error())
	} else {
		utils.Debug("ApiBackend", fmt.Sprintf("compactReactive: conversation saved successfully convID=%s", conv.ID))
	}

	// Reset session memory debounce baselines after reactive compaction.
	if cp.resetMemoryTracking != nil {
		postTokens := conversation.EstimateTokens(conv.Messages)
		cp.resetMemoryTracking(postTokens)
	}

	utils.Log("ApiBackend", fmt.Sprintf("compactReactive COMPLETE: tokensBefore=%d msgsBefore=%d msgsAfter=%d dropped=%d summaryLen=%d clearedBlocks=%d strategy=reactive convID=%s contextWindow=%d",
		tokensBefore, msgBefore, msgAfter, msgBefore-msgAfter, len(summary), cleared, conv.ID, contextWindow))

	// Fire session_compact hook (observe)
	if hooks.OnSessionCompact != nil {
		// Compute post-compaction token count before the hook fires.
		tokensAfter := conversation.GetContextUsage(conv, contextWindow).Tokens

		// Pass facts as a typed slice value on the map payload. See
		// compactIfNeeded for the rationale (no stringly-typed round-trip).
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":         "reactive",
			"messagesBefore":   msgBefore,
			"messagesAfter":    msgAfter,
			"facts":            facts,
			"tokensBefore":     tokensBefore,
			"tokenLimit":       0, // not applicable for reactive compaction
			"targetTokens":     targetTokens,
			"microCompactKeep": cp.microKeepTurns,
			"tokensAfter":      tokensAfter,
			"sessionMemory":    sessionMemory,
		})
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
			utils.Log("ApiBackend", fmt.Sprintf("renderCompactSummary: strategy=%s path=hook summaryLen=%d msgCount=%d", strategy, len(hookSummary), len(scanSlice)))
			return hookSummary, "hook"
		}
		utils.Debug("ApiBackend", fmt.Sprintf("renderCompactSummary: strategy=%s hook present but returned empty, falling back to regex", strategy))
	}
	if len(facts) == 0 {
		utils.Debug("ApiBackend", fmt.Sprintf("renderCompactSummary: strategy=%s path=empty (no facts, no hook)", strategy))
		return "", "empty"
	}
	regex := compaction.FormatFactsSummary(facts)
	utils.Log("ApiBackend", fmt.Sprintf("renderCompactSummary: strategy=%s path=regex summaryLen=%d factCount=%d", strategy, len(regex), len(facts)))
	return regex, "regex"
}

// injectCompactBoundary prepends a compact_boundary message built from
// meta to conv.Messages. Single construction site shared by both
// compactIfNeeded and compactReactive so the on-wire shape stays
// byte-identical regardless of the trigger.
//
// The boundary lives at the head of the slice (index 0) so the next call
// to MessagesAfterLastCompactBoundary finds it as the most recent
// boundary even when subsequent messages are appended.
func injectCompactBoundary(conv *conversation.Conversation, meta conversation.CompactMeta) {
	boundary := conversation.BuildCompactBoundaryMessage(meta)
	conv.Messages = append([]types.LlmMessage{boundary}, conv.Messages...)
}

// firstEntryID returns the ID of the first conversation tree entry, or empty string.
func firstEntryID(conv *conversation.Conversation) string {
	if len(conv.Entries) > 0 {
		return conv.Entries[0].ID
	}
	return ""
}
