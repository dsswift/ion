package backend

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/telemetry"
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
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: extracted facts from -message scan slice (full )", map[string]any{
		"trigger": p.trigger,
		"count":   len(facts),
		"count_2": len(scanSlice),
		"conv":    msgBefore,
	})

	// Step 1: MicroCompact — protect only the most recent N turns (default 3).
	cleared := conversation.MicroCompact(p.conv, p.cp.microKeepTurns)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact step 1: micro-compact cleared", map[string]any{
		"trigger":    p.trigger,
		"tokens":     tokensBefore,
		"limit":      p.tokenLimit,
		"cleared":    cleared,
		"keep_turns": p.cp.microKeepTurns,
	})

	// Step 2: If still above the limit, hard-truncate to a token budget.
	// For "user" trigger we ALWAYS run step 2 regardless of the
	// micro-compact outcome — the user is asking for context reduction
	// and the gentle step is rarely enough on its own. For "auto" we
	// honour the same usage re-check the original compactIfNeeded did,
	// preserving the "step 1 was sufficient" early-exit.
	var summary string
	var sessionMemory string
	// noOp is set true when the hard-truncate path ran but produced nothing
	// worth recording: no summary, no cleared blocks, and no messages dropped.
	// In that case we must NOT inject an (empty) boundary, append a tree entry,
	// or save — doing so would stack an empty compaction on top of a prior one
	// and, because BuildContextPath restarts the LLM view from the newest
	// compaction entry, orphan the previous summary. A no-op /compact must leave
	// .llm.jsonl and .tree.jsonl byte-for-byte untouched. Stays false on the
	// micro-only (else) path, which keeps its existing behavior.
	var noOp bool
	targetTokens := int(float64(p.contextWindow) * p.cp.targetPercent / 100.0)
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: targetTokens formula: * %", map[string]any{
		"trigger":        p.trigger,
		"context_window": p.contextWindow,
		"target_percent": p.cp.targetPercent,
		"target":         targetTokens,
	})
	usageAfterMicro := conversation.GetContextUsage(p.conv, p.contextWindow)
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: usageAfterMicro.", map[string]any{
		"trigger": p.trigger,
		"tokens":  usageAfterMicro.Tokens,
		"limit":   p.tokenLimit,
	})

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
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: LLM summary generated ( chars)", map[string]any{
						"trigger": p.trigger,
						"count":   len(summary),
					})
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
					utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: LLM summary returned empty despite droppedText", map[string]any{
						"trigger": p.trigger,
						"len":     len(droppedText),
					})
				}
			} else {
				utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: no text content for LLM summary", map[string]any{
					"trigger": p.trigger,
				})
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
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: all four summary tiers produced nothing (session memory, LLM, hook, regex)", map[string]any{
					"trigger": p.trigger,
					"path":    path,
				})
			}
		}

		// Now truncate.
		conversation.CompactToTokenBudget(p.conv, targetTokens, p.cp.minKeepTurns, p.cp.estimationPadding)
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact step 2: truncated to (% of ), messages remain", map[string]any{
			"trigger":        p.trigger,
			"budget":         targetTokens,
			"target_percent": p.cp.targetPercent,
			"context_window": p.contextWindow,
			"count":          len(p.conv.Messages),
		})

		// No-op detection: the hard-truncate path ran but nothing was
		// summarized, cleared, or dropped. This happens on a manual /compact of
		// an already-compacted conversation whose only content is a prior
		// boundary. Injecting an empty boundary here (and the tree entry / save
		// below) would orphan the prior summary via BuildContextPath, so we skip
		// all mutation and leave the conversation untouched.
		droppedMessages := len(p.conv.Messages) < msgBefore
		noOp = summary == "" && cleared == 0 && !droppedMessages
		if noOp {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: no-op (no summary, no cleared blocks, no dropped messages) — skipping boundary injection, tree entry, and save to preserve existing context", map[string]any{
				"trigger":         p.trigger,
				"key":             p.run.requestID,
				"conversation_id": p.conv.ID,
			})
		} else {
			// Inject a typed boundary block so the next compaction can slice
			// at this point and avoid re-extracting facts from this summary.
			recentFiles := compaction.ExtractRecentFiles(conversation.MessagesAfterLastCompactBoundary(p.conv))
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: extracted recent files", map[string]any{
				"trigger": p.trigger,
				"count":   len(recentFiles),
			})
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
		}
	} else {
		targetTokens = 0
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: step 1 sufficient, skipping hard truncate", map[string]any{
			"trigger": p.trigger,
			"tokens":  usageAfterMicro.Tokens,
			"limit":   p.tokenLimit,
		})
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
		// MicroOnly is true when step 2 (hard truncate) was skipped: blocks
		// were cleared in place but no messages were dropped. Consumers use
		// this to avoid rendering a misleading "N → N messages" marker.
		MicroOnly: !shouldHardTruncate,
	}})

	// Post-compaction token count. Computed once here and reused by both the
	// context-economy telemetry emit below and the OnSessionCompact hook
	// payload further down (previously computed only inside the hook block).
	tokensAfter := conversation.GetContextUsage(p.conv, p.contextWindow).Tokens

	// Context-economy telemetry (family 4c): emit a compaction data point with
	// the before/after token and message counts, the reclaimed delta, and the
	// summary/fact metrics so consumers can measure compaction effectiveness.
	// Nil-safe on telemetry. The telemetry.Compaction constant names the event.
	// p.run.cfg may be nil on the synthetic CompactNow path (out-of-run user
	// compaction), so guard the cfg dereference.
	if p.run.cfg != nil && p.run.cfg.Telemetry != nil {
		telem := p.run.cfg.Telemetry
		// R11: event name is carried by Event.Name; payload.kind removed.
		telem.Event(telemetry.Compaction, map[string]any{
			"trigger":          p.trigger,
			"tokens_before":    tokensBefore,
			"tokens_after":     tokensAfter,
			"tokens_reclaimed": tokensBefore - tokensAfter,
			"messages_before":  msgBefore,
			"messages_after":   msgAfter,
			"cleared_blocks":   cleared,
			"fact_count":       len(facts),
			"summary_len":      len(summary),
			"target_tokens":    targetTokens,
			"micro_only":       !shouldHardTruncate,
		}, buildTelemCtx(p.run))
	}

	// Record compaction in the conversation tree, persist, and reset memory
	// tracking — but ONLY when this was a real compaction. On a no-op (see the
	// noOp guard above) we skip all three: appending an empty tree entry would
	// orphan the prior summary on the next BuildContextPath, saving would
	// rewrite .llm.jsonl from that orphaned view, and resetting memory tracking
	// would move the debounce baseline for a compaction that never happened.
	if noOp {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: no-op — skipping tree entry, save, and memory-tracking reset", map[string]any{
			"trigger":         p.trigger,
			"key":             p.run.requestID,
			"conversation_id": p.conv.ID,
		})
	} else {
		// Record compaction in the conversation tree (if entries are tracked).
		if p.conv.Entries != nil {
			conversation.AppendEntry(p.conv, conversation.EntryCompaction, conversation.CompactionData{
				Summary:          summary,
				FirstKeptEntryID: firstEntryID(p.conv),
				TokensBefore:     tokensBefore,
				MessagesBefore:   msgBefore,
				MessagesAfter:    msgAfter,
				ClearedBlocks:    cleared,
				Strategy:         p.trigger,
				MicroOnly:        !shouldHardTruncate,
			})
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: appended compaction entry to conversation tree", map[string]any{
				"trigger": p.trigger,
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: conv.Entries is nil, skipping tree entry", map[string]any{
				"trigger": p.trigger,
			})
		}

		// Persist immediately so compaction survives mid-loop crashes.
		if err := conversation.Save(p.conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact: failed to save", map[string]any{
				"trigger": p.trigger,
				"error":   utils.ErrStr(err),
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compact: conversation saved successfully", map[string]any{
				"trigger":         p.trigger,
				"conversation_id": p.conv.ID,
			})
		}

		// Reset session memory debounce baselines so the growth threshold
		// restarts from the post-compaction token count. Without this, the
		// threshold is unreachable because compaction reduced the token count
		// below the previous baseline.
		if p.cp.resetMemoryTracking != nil {
			postTokens := conversation.EstimateTokens(p.conv.Messages)
			p.cp.resetMemoryTracking(postTokens)
		}
	}

	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compact COMPLETE", map[string]any{
		"trigger":         p.trigger,
		"tokens_before":   tokensBefore,
		"msgs_before":     msgBefore,
		"msgs_after":      msgAfter,
		"dropped":         msgBefore - msgAfter,
		"summary_len":     len(summary),
		"cleared_blocks":  cleared,
		"conversation_id": p.conv.ID,
		"context_window":  p.contextWindow,
	})

	// Fire the session_compact observer hook only for a real compaction. On a
	// no-op nothing changed, so a harness observing "a compaction happened"
	// must not be told one did.
	if !noOp && p.hooks.OnSessionCompact != nil {
		// Post-compaction token count (tokensAfter) was already computed above
		// for the compaction telemetry emit; reuse it here for the hook payload.

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
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compactReactive: entry", map[string]any{
		"context_window":   contextWindow,
		"attempt":          attempt,
		"target_percent":   cp.targetPercent,
		"micro_keep_turns": cp.microKeepTurns,
		"min_keep_turns":   cp.minKeepTurns,
		"summary_enabled":  cp.summaryEnabled,
		"memory_enabled":   cp.memoryEnabled,
	})
	// Fire session_before_compact hook (can cancel)
	if hooks.OnSessionBeforeCompact != nil && hooks.OnSessionBeforeCompact(run.requestID) {
		utils.Log("ApiBackend", "reactive compaction cancelled by hook")
		return false
	}

	b.emit(run, types.NormalizedEvent{Data: &types.CompactingEvent{Active: true}})
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "prompt_too_long, compaction attempt /", map[string]any{
		"attempt":                     attempt,
		"max_prompt_too_long_retries": maxPromptTooLongRetries,
	})
	msgBefore := len(conv.Messages)

	// Capture pre-compaction token count for the hook payload.
	usageBefore := conversation.GetContextUsage(conv, contextWindow)
	tokensBefore := usageBefore.Tokens

	// Same duplication firewall as compactIfNeeded — see comment there.
	scanSlice := conversation.MessagesAfterLastCompactBoundary(conv)
	facts := compaction.ExtractFacts(scanSlice)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "reactive compact: extracted facts from -message scan slice (full )", map[string]any{
		"count":   len(facts),
		"count_2": len(scanSlice),
		"conv":    msgBefore,
	})

	// Step 1: micro-compact (tool results, then assistant text)
	cleared := conversation.MicroCompact(conv, cp.microKeepTurns)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "prompt_too_long micro-compact cleared blocks", map[string]any{
		"cleared":    cleared,
		"keep_turns": cp.microKeepTurns,
	})
	usageAfterMicro := conversation.GetContextUsage(conv, contextWindow)
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compactReactive: tokens after micro- (%)", map[string]any{
		"compact": usageAfterMicro.Tokens,
		"pct":     usageAfterMicro.Percent,
	})

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
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "reactive compact: LLM summary generated ( chars)", map[string]any{
					"count": len(summary),
				})
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
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "reactive compact: LLM summary returned empty despite droppedText", map[string]any{
					"len": len(droppedText),
				})
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
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "reactive compact: no summary generated (no facts, no LLM, no hook, no session memory)", map[string]any{
				"path": path,
			})
		}
	}

	// Step 3: hard truncate using progressively smaller token budget on each retry.
	escalatedPercent := cp.targetPercent / float64(attempt)
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compactReactive: % ( / )", map[string]any{
		"escalated_percent": escalatedPercent,
		"target_percent":    cp.targetPercent,
		"attempt":           attempt,
	})
	targetTokens := int(float64(contextWindow) * escalatedPercent / 100.0)
	conversation.CompactToTokenBudget(conv, targetTokens, cp.minKeepTurns, cp.estimationPadding)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "prompt_too_long hard-truncated to (% of ), messages remain", map[string]any{
		"budget":            targetTokens,
		"escalated_percent": escalatedPercent,
		"context_window":    contextWindow,
		"count":             len(conv.Messages),
	})

	// Inject a typed boundary block so the next compaction can slice
	// at this point and avoid re-extracting facts from this summary.
	recentFiles := compaction.ExtractRecentFiles(conversation.MessagesAfterLastCompactBoundary(conv))
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compactReactive: extracted recent files", map[string]any{
		"count": len(recentFiles),
	})
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
		// Reactive compaction always runs the hard-truncate step (step 3),
		// so it is never micro-only. Set explicitly to document the invariant
		// rather than relying on the zero value.
		MicroOnly: false,
	}})

	// Post-compaction token count. Computed once and reused by the
	// context-economy telemetry emit below and the OnSessionCompact hook.
	tokensAfter := conversation.GetContextUsage(conv, contextWindow).Tokens

	// Reactive compaction always hard-truncates, so micro_only is false.
	// Nil-safe on telemetry (and on run.cfg for defensiveness).
	if run.cfg != nil && run.cfg.Telemetry != nil {
		telem := run.cfg.Telemetry
		// R11: event name is carried by Event.Name; payload.kind removed.
		telem.Event(telemetry.Compaction, map[string]any{
			"trigger":          "reactive",
			"tokens_before":    tokensBefore,
			"tokens_after":     tokensAfter,
			"tokens_reclaimed": tokensBefore - tokensAfter,
			"messages_before":  msgBefore,
			"messages_after":   msgAfter,
			"cleared_blocks":   cleared,
			"fact_count":       len(facts),
			"summary_len":      len(summary),
			"target_tokens":    targetTokens,
			"micro_only":       false,
		}, buildTelemCtx(run))
	}

	// Record compaction in the conversation tree (if entries are tracked).
	if conv.Entries != nil {
		conversation.AppendEntry(conv, conversation.EntryCompaction, conversation.CompactionData{
			Summary:          summary,
			FirstKeptEntryID: firstEntryID(conv),
			TokensBefore:     tokensBefore,
			MessagesBefore:   msgBefore,
			MessagesAfter:    msgAfter,
			ClearedBlocks:    cleared,
			Strategy:         "reactive",
			MicroOnly:        false,
		})
		utils.Debug("ApiBackend", "compactReactive: appended compaction entry to conversation tree")
	} else {
		utils.Debug("ApiBackend", "compactReactive: conv.Entries is nil, skipping tree entry")
	}

	// Persist immediately so compaction survives mid-loop crashes.
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save after reactive compaction", map[string]any{
			"error": utils.ErrStr(err),
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "compactReactive: conversation saved successfully", map[string]any{
			"conversation_id": conv.ID,
		})
	}

	// Reset session memory debounce baselines after reactive compaction.
	if cp.resetMemoryTracking != nil {
		postTokens := conversation.EstimateTokens(conv.Messages)
		cp.resetMemoryTracking(postTokens)
	}

	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "compactReactive COMPLETE: strategy=reactive", map[string]any{
		"tokens_before":   tokensBefore,
		"msgs_before":     msgBefore,
		"msgs_after":      msgAfter,
		"dropped":         msgBefore - msgAfter,
		"summary_len":     len(summary),
		"cleared_blocks":  cleared,
		"conversation_id": conv.ID,
		"context_window":  contextWindow,
	})

	// Fire session_compact hook (observe)
	if hooks.OnSessionCompact != nil {
		// tokensAfter was computed above for the compaction telemetry emit;
		// reuse it here for the hook payload.

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
	// Locked funnel: a concurrent Save (signal-handler flush) snapshots
	// Messages under the conversation lock; reassigning the slice here
	// directly would race it (see conversation/lock.go).
	conversation.PrependMessage(conv, boundary)
}

// firstEntryID returns the ID of the first conversation tree entry, or empty string.
func firstEntryID(conv *conversation.Conversation) string {
	return conversation.FirstEntryID(conv)
}
