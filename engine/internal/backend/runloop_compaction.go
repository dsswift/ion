package backend

import (
	"context"
	"fmt"
	"strings"

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
	return p
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
// ctx is threaded for LLM-based summarisation (tier 2 of the three-tier
// summary fallback: session memory → LLM → regex).
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
		return
	}

	run.compactionsWithoutProgress++

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	msgBefore := len(conv.Messages)

	// Extract facts before any mutation so they reflect the full pre-compaction state.
	facts := compaction.ExtractFacts(conv.Messages)
	utils.Log("ApiBackend", fmt.Sprintf("proactive compact: extracted %d facts from %d messages", len(facts), msgBefore))

	// Step 1: MicroCompact — protect only the most recent N turns (default 3).
	cleared := conversation.MicroCompact(conv, cp.microKeepTurns)
	utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 1: tokens=%d limit=%d micro-compact cleared %d (keepTurns=%d)", usage.Tokens, tokenLimit, cleared, cp.microKeepTurns))

	// Step 2: If still above the limit, hard-truncate to a token budget.
	var summary string
	var sessionMemory string
	targetTokens := int(float64(contextWindow) * cp.targetPercent / 100.0)
	usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
	if usageAfterMicro.Tokens > tokenLimit {

		// Three-tier summary fallback: session memory → LLM → regex.
		// Must generate summary BEFORE truncation drops the messages.
		if cp.getSessionMemory != nil {
			if mem := cp.getSessionMemory(); mem != "" {
				summary = mem
				sessionMemory = mem
				utils.Log("ApiBackend", "proactive compact: using session memory as summary")
			}
		}
		if summary == "" && cp.summaryEnabled {
			droppedText := compaction.FormatMessagesForSummary(conv.Messages)
			if droppedText != "" {
				llmSummary, llmUsage := compaction.Summarize(ctx, droppedText, cp.summaryModel, cp.summaryMaxTokens)
				if llmSummary != "" {
					summary = llmSummary
					utils.Log("ApiBackend", fmt.Sprintf("proactive compact: LLM summary generated (%d chars)", len(summary)))
					if llmUsage != nil {
						totalIn := llmUsage.InputTokens + llmUsage.CacheReadInputTokens + llmUsage.CacheCreationInputTokens
						b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
							Usage: types.UsageData{
								InputTokens:  &totalIn,
								OutputTokens: &llmUsage.OutputTokens,
							},
						}})
					}
				}
			} else {
				utils.Debug("ApiBackend", "proactive compact: no text content for LLM summary")
			}
		}
		if summary == "" && len(facts) > 0 {
			summary = compaction.FormatFactsSummary(facts)
			utils.Log("ApiBackend", fmt.Sprintf("proactive compact: regex fact summary (%d facts)", len(facts)))
		}

		// Now truncate.
		conversation.CompactToTokenBudget(conv, targetTokens, cp.minKeepTurns, cp.estimationPadding)
		utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 2: truncated to budget=%d (%.0f%% of %d), %d messages remain", targetTokens, cp.targetPercent, contextWindow, len(conv.Messages)))
	} else {
		targetTokens = 0
		utils.Debug("ApiBackend", fmt.Sprintf("proactive compact: step 1 sufficient, skipping hard truncate (tokens=%d limit=%d)", usageAfterMicro.Tokens, tokenLimit))
	}

	// Inject post-compact context as a transient system message instead of
	// regular user messages. Transient messages are not persisted and don't
	// count as "turns" for future compaction decisions.
	var compactNotice strings.Builder
	compactNotice.WriteString("[SYSTEM] Context compaction completed.")
	if cleared > 0 {
		fmt.Fprintf(&compactNotice, " Cleared %d older tool results.", cleared)
	}
	if summary != "" {
		fmt.Fprintf(&compactNotice, "\n\n[Extracted facts from compacted context]:\n%s", summary)
	}
	recentFiles := compaction.ExtractRecentFiles(conv.Messages)
	if len(recentFiles) > 0 {
		fmt.Fprintf(&compactNotice, "\n\nRecently modified files: %s", strings.Join(recentFiles, ", "))
	}
	// Include transcript path so the model can read full pre-compaction history.
	if cp.convDir != "" && conv.ID != "" {
		fmt.Fprintf(&compactNotice, "\n\nFull conversation history is preserved at: %s/%s.tree.jsonl", cp.convDir, conv.ID)
	}
	compactNotice.WriteString("\n\nUse the SearchHistory tool to find specific details from the compacted conversation, or re-read relevant files. Continue the conversation from where it left off without recapping what was happening.")
	conversation.AddTransientUserMessage(conv, compactNotice.String())

	// Emit enriched completion event so clients can render a compaction marker.
	msgAfter := len(conv.Messages)
	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{
		Active:         false,
		Summary:        summary,
		MessagesBefore: msgBefore,
		MessagesAfter:  msgAfter,
		ClearedBlocks:  cleared,
		Strategy:       "auto",
	}})

	// Record compaction in the conversation tree (if entries are tracked).
	if conv.Entries != nil {
		conversation.AppendEntry(conv, conversation.EntryCompaction, conversation.CompactionData{
			Summary:          summary,
			FirstKeptEntryID: firstEntryID(conv),
			TokensBefore:     usage.Tokens,
		})
	}

	// Persist immediately so compaction survives mid-loop crashes.
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save after compaction: "+err.Error())
	}

	if hooks.OnSessionCompact != nil {
		// Compute post-compaction token count before the hook fires.
		tokensAfter := conversation.GetContextUsage(conv, contextWindow).Tokens

		// Pass facts as a typed slice value on the map payload. The session
		// bridge in prompt_runconfig.go downcasts it directly — no
		// stringly-typed intermediate. nil is fine; the bridge handles
		// missing/empty facts symmetrically.
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":         "auto",
			"messagesBefore":   msgBefore,
			"messagesAfter":    msgAfter,
			"facts":            facts,
			"tokensBefore":     usage.Tokens,
			"tokenLimit":       tokenLimit,
			"targetTokens":     targetTokens,
			"microCompactKeep": cp.microKeepTurns,
			"tokensAfter":      tokensAfter,
			"sessionMemory":    sessionMemory,
		})
	}
}

// compactReactive runs the 3-step reactive compaction triggered by a
// prompt_too_long / overloaded provider error. attempt is 1-based; the caller
// passes the post-increment value so the token budget shrinks progressively
// on each retry (targetPercent / attempt). Returns true if compaction ran,
// false when the session_before_compact hook cancelled it (the caller should
// still retry the turn as-is in that case).
//
// ctx is threaded for LLM-based summarisation (tier 2 of the three-tier
// summary fallback: session memory → LLM → regex).
func (b *ApiBackend) compactReactive(ctx context.Context, run *activeRun, conv *conversation.Conversation, hooks RunHooks, contextWindow, attempt int, cp compactParams) bool {
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

	// Extract facts up front (above all message mutation) so they reflect the
	// pre-compaction state and so the same slice serves both the in-context
	// summary and the session_compact hook payload. ExtractFacts is safe on
	// empty/nil inputs.
	facts := compaction.ExtractFacts(conv.Messages)
	utils.Log("ApiBackend", fmt.Sprintf("reactive compact: extracted %d facts from %d messages", len(facts), msgBefore))

	// Step 1: micro-compact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, cp.microKeepTurns)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long micro-compact cleared %d blocks (keepTurns=%d)", cleared, cp.microKeepTurns))

	// Step 2: Three-tier summary fallback: session memory → LLM → regex.
	// Must generate summary BEFORE step 3 truncation drops the messages.
	var summary string
	var sessionMemory string
	if cp.getSessionMemory != nil {
		if mem := cp.getSessionMemory(); mem != "" {
			summary = mem
			sessionMemory = mem
			utils.Log("ApiBackend", "reactive compact: using session memory as summary")
		}
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
			}
		} else {
			utils.Debug("ApiBackend", "reactive compact: no text content for LLM summary")
		}
	}
	if summary == "" && len(facts) > 0 {
		summary = compaction.FormatFactsSummary(facts)
		utils.Log("ApiBackend", fmt.Sprintf("reactive compact: regex fact summary (%d facts)", len(facts)))
	} else if summary == "" {
		utils.Debug("ApiBackend", "reactive compact: no summary generated (no facts, no LLM, no session memory)")
	}

	// Step 3: hard truncate using progressively smaller token budget on each retry.
	escalatedPercent := cp.targetPercent / float64(attempt)
	targetTokens := int(float64(contextWindow) * escalatedPercent / 100.0)
	conversation.CompactToTokenBudget(conv, targetTokens, cp.minKeepTurns, cp.estimationPadding)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long hard-truncated to budget=%d (%.0f%% of %d), %d messages remain",
		targetTokens, escalatedPercent, contextWindow, len(conv.Messages)))

	// Inject post-compact context as a single transient message.
	var compactNotice strings.Builder
	compactNotice.WriteString("[SYSTEM] Context compaction completed (reactive — provider reported prompt too long).")
	if cleared > 0 {
		fmt.Fprintf(&compactNotice, " Cleared %d older tool results.", cleared)
	}
	if summary != "" {
		fmt.Fprintf(&compactNotice, "\n\n[Extracted facts from compacted context]:\n%s", summary)
	}
	recentFiles := compaction.ExtractRecentFiles(conv.Messages)
	if len(recentFiles) > 0 {
		fmt.Fprintf(&compactNotice, "\n\nRecently modified files: %s", strings.Join(recentFiles, ", "))
	}
	if cp.convDir != "" && conv.ID != "" {
		fmt.Fprintf(&compactNotice, "\n\nFull conversation history is preserved at: %s/%s.tree.jsonl", cp.convDir, conv.ID)
	}
	compactNotice.WriteString("\n\nUse the SearchHistory tool to find specific details from the compacted conversation, or re-read relevant files. Continue the conversation from where it left off without recapping what was happening.")
	conversation.AddTransientUserMessage(conv, compactNotice.String())

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
			TokensBefore:     0, // not available for reactive compaction
		})
	}

	// Persist immediately so compaction survives mid-loop crashes.
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save after reactive compaction: "+err.Error())
	}

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

// firstEntryID returns the ID of the first conversation tree entry, or empty string.
func firstEntryID(conv *conversation.Conversation) string {
	if len(conv.Entries) > 0 {
		return conv.Entries[0].ID
	}
	return ""
}
