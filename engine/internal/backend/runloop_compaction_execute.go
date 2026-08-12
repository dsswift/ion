package backend

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// performCompact plans before summarizing, commits the tree/message mutation
// atomically, and persists it. User-triggered targets are relative to the
// truncatable message estimate; auto targets retain window-relative semantics.
func (b *ApiBackend) performCompact(p performCompactParams) error {
	b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	msgBefore := len(p.conv.Messages)
	tokensBefore := conversation.GetContextUsage(p.conv, p.contextWindow).Tokens

	cleared := conversation.MicroCompact(p.conv, p.cp.microKeepTurns)
	usageAfterMicro := conversation.GetContextUsage(p.conv, p.contextWindow)
	shouldHardTruncate := usageAfterMicro.Tokens > p.tokenLimit || p.trigger == "user"

	targetTokens := 0
	contextTargetTokens := 0
	targetBasis := "none"
	var cut conversation.TokenBudgetCut
	if shouldHardTruncate {
		targetBasis = "window"
		contextTargetTokens = int(float64(p.contextWindow) * p.cp.targetPercent / 100.0)
		messageEstimate := conversation.EstimateTokenBudgetInput(p.conv.Messages, p.cp.estimationPadding)
		// Preserve window-relative semantics for auto/reactive while translating
		// the total-context target into the message-only budget this trimmer can
		// affect. Provider usage includes system/tools/cache overhead; subtract that
		// fixed portion or the message cut may be unreachable.
		fixedOverhead := usageAfterMicro.Tokens - messageEstimate
		if fixedOverhead < 0 {
			fixedOverhead = 0
		}
		targetTokens = contextTargetTokens - fixedOverhead
		if p.trigger == "user" {
			targetBasis = "truncatable_messages"
			contextTargetTokens = 0
			targetTokens = int(float64(messageEstimate) * p.cp.targetPercent / 100.0)
		}
		if targetTokens <= 0 && messageEstimate > 0 {
			targetTokens = 1
		}
		cut = conversation.PlanTokenBudgetCut(p.conv.Messages, targetTokens, p.cp.minKeepTurns, p.cp.estimationPadding)
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact target resolved", map[string]any{
		"trigger": p.trigger, "target_basis": targetBasis, "target_tokens": targetTokens,
		"context_target_tokens": contextTargetTokens,
		"estimated_tokens":      cut.EstimatedTokens, "dropped_messages": cut.Dropped,
		"cleared_blocks": cleared,
	})

	// A no-op is defined only by mutation. Do not pay for a summary or claim a
	// compaction occurred merely because a summary string could be generated.
	noOp := cleared == 0 && cut.Dropped == 0
	microOnly := !noOp && cut.Dropped == 0
	var summary, sessionMemory string
	var facts []compaction.Fact
	if noOp {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact no-op: no clearable blocks or droppable messages", map[string]any{
			"trigger": p.trigger, "conversation_id": p.conv.ID,
		})
	} else {
		// Summaries describe only data being discarded. A micro-only pass has no
		// dropped prefix and needs no summary.
		droppedPrefix := p.conv.Messages[:cut.CutIndex]
		if cut.Dropped > 0 {
			facts = compaction.ExtractFacts(droppedPrefix)
			if mem, reason := p.cp.resolveSessionMemory(p.conv, p.trigger); mem != "" {
				summary, sessionMemory = mem, mem
				utils.Log("ApiBackend", reason)
			}
			if summary == "" && p.cp.summaryEnabled {
				text := compaction.FormatMessagesForSummary(droppedPrefix)
				if text != "" {
					llmSummary, usage := compaction.Summarize(p.ctx, text, p.cp.summaryModel, p.cp.summaryMaxTokens)
					summary = llmSummary
					if usage != nil {
						totalIn := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
						b.emit(p.run, types.NormalizedEvent{Data: &types.UsageEvent{Usage: types.UsageData{InputTokens: &totalIn, OutputTokens: &usage.OutputTokens}}})
					}
				}
			}
			if summary == "" {
				summary, _ = renderCompactSummary(p.run.requestID, p.hooks, p.trigger, droppedPrefix, facts)
			}
		}

		if microOnly {
			if err := conversation.CommitMicroCompaction(p.conv); err != nil {
				b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false, MessagesBefore: msgBefore, MessagesAfter: msgBefore, Strategy: p.trigger, MicroOnly: true}})
				return fmt.Errorf("commit micro compaction: %w", err)
			}
		} else {
			recentFiles := compaction.ExtractRecentFiles(p.conv.Messages[cut.CutIndex:])
			meta := conversation.CompactMeta{
				Trigger: p.trigger, MessagesSummarized: cut.Dropped,
				MessagesBefore: msgBefore, MessagesAfter: msgBefore - cut.Dropped + 1,
				ClearedBlocks: cleared, TokensBefore: tokensBefore, Summary: summary,
				FactCount: len(facts), RecentFiles: recentFiles,
			}
			data := conversation.CompactionData{
				Summary: summary, TokensBefore: tokensBefore, MessagesSummarized: cut.Dropped,
				MessagesBefore: msgBefore, MessagesAfter: meta.MessagesAfter, ClearedBlocks: cleared,
				Strategy: p.trigger, FactCount: len(facts), RecentFiles: recentFiles,
			}
			if _, err := conversation.CommitCompaction(p.conv, cut, data, conversation.BuildCompactBoundaryMessage(meta)); err != nil {
				b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: false, MessagesBefore: msgBefore, MessagesAfter: msgBefore, Strategy: p.trigger}})
				return fmt.Errorf("commit compaction: %w", err)
			}
		}
	}

	storedMsgAfter := len(p.conv.Messages)
	sourceMsgAfter := msgBefore
	if !noOp {
		if microOnly {
			sourceMsgAfter = msgBefore
		} else {
			// Stored slice includes the hard-compaction boundary.
			sourceMsgAfter = storedMsgAfter - 1
		}
	}
	b.emit(p.run, types.NormalizedEvent{Data: &types.CompactingEvent{
		Active: false, Summary: summary, MessagesBefore: msgBefore, MessagesAfter: sourceMsgAfter,
		ClearedBlocks: cleared, Strategy: p.trigger, MicroOnly: microOnly,
	}})
	tokensAfter := conversation.GetContextUsage(p.conv, p.contextWindow).Tokens

	if p.run.cfg != nil && p.run.cfg.Telemetry != nil {
		p.run.cfg.Telemetry.Event(telemetry.Compaction, map[string]any{
			"trigger": p.trigger, "tokens_before": tokensBefore, "tokens_after": tokensAfter,
			"tokens_reclaimed": tokensBefore - tokensAfter, "messages_before": msgBefore,
			"messages_after": sourceMsgAfter, "stored_messages_after": storedMsgAfter, "dropped_messages": cut.Dropped,
			"cleared_blocks": cleared, "fact_count": len(facts), "summary_len": len(summary),
			"target_tokens": targetTokens, "target_basis": targetBasis, "micro_only": microOnly,
		}, buildTelemCtx(p.run))
	}

	if !noOp {
		if err := conversation.Save(p.conv, ""); err != nil {
			return fmt.Errorf("save compacted conversation: %w", err)
		}
		if p.cp.resetMemoryTracking != nil {
			p.cp.resetMemoryTracking(conversation.EstimateTokens(p.conv.Messages))
		}
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact COMPLETE", map[string]any{
		"trigger": p.trigger, "tokens_before": tokensBefore, "tokens_after": tokensAfter,
		"messages_before": msgBefore, "messages_after": sourceMsgAfter, "stored_messages_after": storedMsgAfter,
		"dropped_messages": cut.Dropped, "summary_len": len(summary),
		"cleared_blocks": cleared, "conversation_id": p.conv.ID,
	})
	if !noOp && p.hooks.OnSessionCompact != nil {
		p.hooks.OnSessionCompact(p.run.requestID, map[string]interface{}{
			"strategy": p.trigger, "messagesBefore": msgBefore, "messagesAfter": sourceMsgAfter,
			"facts": facts, "tokensBefore": tokensBefore, "tokenLimit": p.tokenLimit,
			"targetTokens": targetTokens, "microCompactKeep": p.cp.microKeepTurns,
			"tokensAfter": tokensAfter, "sessionMemory": sessionMemory,
		})
	}
	return nil
}
