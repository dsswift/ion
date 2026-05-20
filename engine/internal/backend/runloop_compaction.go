package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// maxPromptTooLongRetries caps reactive compaction attempts triggered by
// prompt_too_long / overloaded_error responses before giving up on the run.
const maxPromptTooLongRetries = 3

// compactIfNeeded performs proactive compaction when context usage exceeds
// the absolute token limit. Honours the session_before_compact hook (which
// can cancel the operation) and emits CompactingEvent edges so the desktop
// can render progress. The session_compact observer hook fires on completion.
//
// tokenLimit is the absolute token count above which compaction should fire
// (see conversation.AutoCompactTokenLimit for how this is derived from the
// raw context window).
//
// A per-run counter bounds consecutive attempts: if the conversation cannot
// be shrunk below the limit in maxConsecutiveCompactions attempts, the run
// emits an ErrorEvent with code compact_loop_aborted and stops trying
// proactively. The counter resets on any successful API response.
func (b *ApiBackend) compactIfNeeded(run *activeRun, conv *conversation.Conversation, hooks RunHooks, contextWindow, tokenLimit int) {
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

	// Step 1: MicroCompact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, 10)
	utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 1: tokens=%d limit=%d micro-compact cleared %d", usage.Tokens, tokenLimit, cleared))

	// Surface compaction to the model so it knows data was lost.
	if cleared > 0 {
		conversation.AddTransientUserMessage(conv,
			fmt.Sprintf("[SYSTEM] Context compaction cleared %d older tool results. "+
				"Use the SearchHistory tool to find specific details from the compacted conversation, or re-read relevant files.", cleared))
	}

	// Step 2: if still above the limit, extract facts and hard-truncate.
	// GetContextUsage falls back to estimation here because MicroCompact
	// invalidated the cached token count.
	var summary string
	usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
	if usageAfterMicro.Tokens > tokenLimit {
		facts := compaction.ExtractFacts(conv.Messages)
		conversation.Compact(conv, 10)
		if len(facts) > 0 {
			summary = compaction.FormatFactsSummary(facts)
			restoreMsg := compaction.PostCompactRestore(conv, compaction.ExtractRecentFiles(conv.Messages), nil)
			if summary != "" {
				factMsg := types.LlmMessage{
					Role: "user",
					Content: []types.LlmContentBlock{{
						Type: "text",
						Text: "[Extracted facts from compacted context]:\n" + summary,
					}},
				}
				conv.Messages = append([]types.LlmMessage{factMsg, restoreMsg}, conv.Messages...)
			}
		}
		utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 2: hard-truncated to %d messages", len(conv.Messages)))
	}

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

	if hooks.OnSessionCompact != nil {
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":       "auto",
			"messagesBefore": msgBefore,
			"messagesAfter":  msgAfter,
		})
	}
}

// compactReactive runs the 3-step reactive compaction triggered by a
// prompt_too_long / overloaded provider error. attempt is 1-based; the caller
// passes the post-increment value so step-3 keepTurns shrinks on each retry
// (10, 5, 3). Returns true if compaction ran, false when the
// session_before_compact hook cancelled it (the caller should still retry the
// turn as-is in that case).
func (b *ApiBackend) compactReactive(run *activeRun, conv *conversation.Conversation, hooks RunHooks, attempt int) bool {
	// Fire session_before_compact hook (can cancel)
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.Log("ApiBackend", "reactive compaction cancelled by hook")
		return false
	}

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long, compaction attempt %d/%d", attempt, maxPromptTooLongRetries))
	msgBefore := len(conv.Messages)

	// Step 1: micro-compact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, 10)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long micro-compact cleared %d blocks", cleared))

	// Surface compaction to the model so it knows data was lost.
	if cleared > 0 {
		conversation.AddTransientUserMessage(conv,
			fmt.Sprintf("[SYSTEM] Context compaction cleared %d older tool results. "+
				"Use the SearchHistory tool to find specific details from the compacted conversation, or re-read relevant files.", cleared))
	}

	// Step 2: fact extraction
	var summary string
	facts := compaction.ExtractFacts(conv.Messages)
	if len(facts) > 0 {
		summary = compaction.FormatFactsSummary(facts)
		restoreMsg := compaction.PostCompactRestore(conv, compaction.ExtractRecentFiles(conv.Messages), nil)
		if summary != "" {
			factMsg := types.LlmMessage{
				Role: "user",
				Content: []types.LlmContentBlock{{
					Type: "text",
					Text: "[Extracted facts from compacted context]:\n" + summary,
				}},
			}
			conv.Messages = append([]types.LlmMessage{factMsg, restoreMsg}, conv.Messages...)
		}
	}

	// Step 3: hard truncate -- use progressively smaller keepTurns on each retry
	keepTurns := 10 / attempt // 10, 5, 3
	conversation.Compact(conv, keepTurns)
	utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long hard-truncated to keepTurns=%d, %d messages remain", keepTurns, len(conv.Messages)))

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

	// Fire session_compact hook (observe)
	if hooks.OnSessionCompact != nil {
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":       "reactive",
			"messagesBefore": msgBefore,
			"messagesAfter":  msgAfter,
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
