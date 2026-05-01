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
// the threshold. Honours the session_before_compact hook (which can cancel
// the operation) and emits CompactingEvent edges so the desktop can render
// progress. The session_compact observer hook fires on completion.
func (b *ApiBackend) compactIfNeeded(run *activeRun, conv *conversation.Conversation, hooks RunHooks, contextWindow, threshold int) {
	usage := conversation.GetContextUsage(conv, contextWindow)
	if usage.Percent <= threshold {
		return
	}

	// Fire session_before_compact hook (can cancel)
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		return
	}

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	msgBefore := len(conv.Messages)

	// Step 1: MicroCompact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, 10)
	utils.Log("ApiBackend", fmt.Sprintf("proactive compact step 1: was %d%%, micro-compact cleared %d", usage.Percent, cleared))

	// Step 2: if still above threshold, extract facts and hard-truncate
	usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
	if usageAfterMicro.Percent > threshold {
		facts := compaction.ExtractFacts(conv.Messages)
		conversation.Compact(conv, 10)
		if len(facts) > 0 {
			summary := compaction.FormatFactsSummary(facts)
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

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false}})

	if hooks.OnSessionCompact != nil {
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":       "auto",
			"messagesBefore": msgBefore,
			"messagesAfter":  len(conv.Messages),
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

	// Step 2: fact extraction
	facts := compaction.ExtractFacts(conv.Messages)
	if len(facts) > 0 {
		summary := compaction.FormatFactsSummary(facts)
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

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false}})

	// Fire session_compact hook (observe)
	if hooks.OnSessionCompact != nil {
		hooks.OnSessionCompact(run.requestID, map[string]interface{}{
			"strategy":       "reactive",
			"messagesBefore": msgBefore,
			"messagesAfter":  len(conv.Messages),
		})
	}
	return true
}
