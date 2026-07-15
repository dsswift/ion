package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runLoop is the core agent loop. It calls the provider, processes the
// response, executes tools, and loops until the model signals end_turn,
// the budget is exceeded, or the context is cancelled.
func (b *ApiBackend) runLoop(ctx context.Context, run *activeRun, opts types.RunOptions) {
	// Install the run's correlation context as this goroutine's ambient logger
	// context, then clear it on exit. See installAmbientLogging (runloop_ambient.go)
	// for the full rationale: every utils.Log/Debug/Info/Warn/Error call made
	// from this goroutine auto-stamps session_id/conversation_id/trace_id.
	defer installAmbientLogging(ctx)()

	defer b.removeRun(run.requestID)

	// Snapshot per-run hooks once. Nil cfg means "no hooks" -- the empty
	// RunHooks struct has nil callback fields, which the call sites below
	// already guard against.
	var hooks RunHooks
	if run.cfg != nil {
		hooks = run.cfg.Hooks
	}

	// Install the provider stream-idle deadline for this run from the resolved
	// timeouts config. See installStreamIdleTimeout (runloop_stream_idle.go).
	installStreamIdleTimeout(run)

	// Resolve the effective early-stop continuation config for this run.
	// Defaults < engine.json < RunOptions < sub-agent gate. Log the final
	// snapshot once at INFO so a reader can reconstruct the decision path
	// from logs alone (per CLAUDE.md logging policy).
	earlyStop := mergeEarlyStopConfig(opts, run.cfg)
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "earlyStop", map[string]any{
		"run_id":            run.requestID,
		"enabled":           earlyStop.enabled,
		"budget":            earlyStop.budget,
		"threshold":         earlyStop.thresholdPct,
		"cap":               earlyStop.maxContinuations,
		"diminishing_delta": earlyStop.diminishingDelta,
		"source":            earlyStop.source,
		"is_subagent":       opts.IsSubagent,
	})

	// Resolve provider — applies the engine's graceful-degradation
	// policy (fall back to DefaultModel when the requested model is
	// unknown) and emits ModelFallbackEvent on the swap path. See
	// runloop_provider_resolve.go for the full contract; on any
	// non-recoverable failure the helper has already emitted the
	// appropriate ErrorEvent + exit and we just return.
	provider, model := b.resolveProviderForRun(run, &opts)
	if provider == nil {
		return
	}

	// Load or create conversation
	conv, convErr := loadOrCreateConversation(opts, model)
	if convErr != nil {
		msg := fmt.Sprintf("Failed to load conversation %s: %v. Your conversation history is safe on disk — please retry.", opts.ConversationID, convErr)
		utils.Error("ApiBackend", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "conversation_load_failed",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.ConversationID)
		return
	}
	run.conv = conv

	// Initialize the read-triggered nested context sink. The dedup set is
	// seeded later, after the system prompt is built (so conv.System carries
	// the eager context blocks we must not re-inject).
	run.touchedSink = types.NewTouchedPathSink()

	// Resolve the conversations directory for post-compact .tree.jsonl path
	// injection. Best-effort: an error just leaves the path empty.
	convDir := ""
	if home, err := os.UserHomeDir(); err == nil {
		convDir = filepath.Join(home, ".ion", "conversations")
	}

	// Emit the conversation/session ID early so the session manager can
	// capture it before the first tool call or dispatch completes. Without
	// this, s.conversationID is empty during the first run until
	// handleRunExit fires, which causes dispatch persistence to silently
	// skip writing agent_dispatch entries.
	b.emit(run, types.NormalizedEvent{Data: &types.SessionInitEvent{
		SessionID: conv.ID,
	}})

	// Persist the working directory so migrated conversations carry the project context.
	if opts.ProjectPath != "" && conv.WorkingDirectory == "" {
		conv.WorkingDirectory = opts.ProjectPath
	}

	// Build system prompt (may rewrite opts.Prompt and opts.PlanModeTools)
	conv.System = buildSystemPrompt(&opts, conv, hooks, run.requestID, run)

	// Seed the nested-context dedup set now that conv.System carries the eager
	// root/home context blocks. Scanning conv.System + conv.Messages recovers
	// every "# Context from <path>" already present (eager walk this turn, plus
	// any nested injections from prior sessions in history) so the nested
	// loader never re-injects a file that is already in the conversation.
	seeded := seedInjectedNestedPaths(conv, opts)
	run.mu.Lock()
	run.injectedNestedPaths = seeded
	run.mu.Unlock()
	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "nestedContext: seeded already-present context path(s)", map[string]any{
		"run_id": run.requestID,
		"count":  len(seeded),
	})

	// Append the inbound user turn. See appendInboundUserMessage for the
	// attachment / slash-command-split handling (extracted to keep this file
	// under the size cap).
	//
	// The engine does NOT echo the appended user turn back to clients. A user
	// turn is either (1) the local client's own input — which the client already
	// rendered optimistically and does not need echoed back to remember — or
	// (2) a turn originated on another client, whose live cross-device echo is
	// owned by the desktop↔client wire (the desktop pipeline's
	// desktop_message_added), not by the engine. The persisted turn is the
	// snapshot authority: it lives in the conversation transcript and reaches
	// every consumer via history load. Re-broadcasting it as a live event would
	// duplicate the client's own input and force a dedup contract on every
	// consumer; it also surfaced extension-injected turns (ctx.sendMessage) as
	// phantom user bubbles. See the removal of engine_user_turn.
	appendInboundUserMessage(conv, &opts)
	// Persist immediately: if the engine dies mid-stream, the user prompt
	// must survive so the user does not lose what they just typed.
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after AddUserMessage", map[string]any{
			"error": utils.ErrStr(err),
		})
	}

	// Resolve limits. Engine ships unopinionated: maxTurns/maxBudget <= 0 means
	// "no cap" -- the agent loop runs until the LLM emits a terminal stop or
	// the caller cancels. Harness engineers cap via RunOptions, engine.json
	// limits, or per-dispatch options.
	maxTurns := opts.MaxTurns
	maxBudget := opts.MaxBudgetUsd

	// Build tool definitions (built-in + external/MCP + capabilities + filters)
	toolDefs, serverTools := b.buildToolDefs(run, opts, provider)

	// Resolve context window for compaction checks. resolveContextWindow
	// guards against a registry entry with ContextWindow == 0 (which would
	// otherwise collapse compaction to a 0-token budget every turn).
	contextWindow := resolveContextWindow(model)

	// Track consecutive prompt_too_long compaction failures to prevent infinite loops
	promptTooLongRetries := 0
	truncationRetries := 0

	// Agent loop: turn increments at the top of each iteration (before
	// turn_start fires), so the first turn has turn=1. This matches the
	// TS reference where turnCount increments at the top of the while loop.
	// run.turnCount mirrors `turn` atomically so Cancel and other RPC paths
	// can read the latest value without taking run.mu.
	var turn int
	for maxTurns <= 0 || turn < maxTurns {
		if ctx.Err() != nil {
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "run cancelled: cost=$", map[string]any{
				"run_id":     run.requestID,
				"turns":      turn,
				"total_cost": run.totalCost,
			})
			b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
			return
		}

		// Check for steer messages that arrived between turns.
		b.drainSteer(run, conv)

		// Increment turn counter before firing turn_start, so the first turn
		// reports turn=1 (matching TS behavior).
		turn++
		run.turnCount.Store(int64(turn))
		// Belt-and-suspenders progress bump (see bumpProgressAtTurnBoundary).
		run.bumpProgressAtTurnBoundary()

		// Read-triggered nested context loading: drain the paths tools touched
		// last turn and inject any not-yet-seen AGENTS.md/ION.md (and, when
		// gated on, CLAUDE.md) from directories below cwd on the path to each
		// touched file. Runs before streamOpts is built so new subtree context
		// reaches the model on this turn's provider call.
		b.drainNestedContext(run, conv, hooks, opts, opts.ProjectPath, turn, maxTurns)

		// Wind-down: warn the LLM 2 turns before max so it can wrap up
		if maxTurns > 4 && turn == maxTurns-2 {
			b.injectSystemMessage(run, conv, hooks, opts, "turn_limit_warning",
				"[SYSTEM] You are approaching your turn limit. You have 2 turns remaining. Wrap up your current work, summarize what you've accomplished and what remains, then return your response.",
				turn, maxTurns)
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "wind-down injected: /", map[string]any{
				"run_id":    run.requestID,
				"turn":      turn,
				"max_turns": maxTurns,
			})
		}

		// Plan mode: inject sparse reminder so the LLM doesn't drift from
		// plan-mode constraints mid-conversation. Two cases fire the reminder:
		//   1. Turn 2+ in any plan-mode run (existing throttle, once per
		//      planModeReminderInterval turns). Handles multi-turn runs.
		//   2. Turn 1 of a run where the conversation already has many messages
		//      (mature single-turn rounds). This is the mid-plan "what's next?"
		//      case where the full prompt is ~220+ messages back and the model
		//      needs the rule in recent context.
		// See shouldInjectPlanModeReminderForRun in plan_mode_prompt.go for
		// the full gate logic and planModeFirstTurnReminderThreshold rationale.
		if run.planMode {
			msgCount := len(conv.Messages)
			run.mu.Lock()
			lastReminderTurn := run.planModeReminderTurn
			shouldInject := shouldInjectPlanModeReminderForRun(turn, lastReminderTurn, msgCount)
			if shouldInject {
				run.planModeReminderTurn = turn
			}
			run.mu.Unlock()
			if shouldInject {
				reminderText := buildPlanModeSparseReminder(run.planFilePath)
				if run.planModeSparseReminderOverride != "" {
					reminderText = run.planModeSparseReminderOverride
				}
				gate := "turn_gt1"
				if turn == 1 {
					gate = "mature_session"
				}
				source := "default"
				if run.planModeSparseReminderOverride != "" {
					source = "override"
				}
				b.injectSystemMessage(run, conv, hooks, opts, "plan_mode_reminder",
					"[SYSTEM] "+reminderText,
					turn, maxTurns)
				utils.LogWithFields(utils.LevelInfo, "backend.plan_mode", "reminder injected", map[string]any{
					"run_id":    run.requestID,
					"turn":      turn,
					"last_turn": lastReminderTurn,
					"interval":  planModeReminderInterval,
					"gate":      gate,
					"count":     msgCount,
					"source":    source,
				})
			} else {
				utils.LogWithFields(utils.LevelDebug, "backend.plan_mode", "reminder throttled", map[string]any{
					"run_id":    run.requestID,
					"turn":      turn,
					"last_turn": lastReminderTurn,
					"next_at":   lastReminderTurn + planModeReminderInterval,
				})
			}
		}

		// Fire turn_start hook
		if hooks.OnTurnStart != nil {
			if _, err := runHookCtx(ctx, func() struct{} {
				hooks.OnTurnStart(run.requestID, turn)
				return struct{}{}
			}); err != nil {
				utils.LogWithFields(utils.LevelWarn, "backend.runloop", "turn_start hook cancelled", map[string]any{
					"run_id": run.requestID,
					"turn":   turn,
				})
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
		}

		// Check budget
		if maxBudget > 0 && run.totalCost >= maxBudget {
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "budget exceeded: cost=$ budget=$", map[string]any{
				"run_id":     run.requestID,
				"total_cost": run.totalCost,
				"max_budget": maxBudget,
			})
			b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
				ErrorMessage: fmt.Sprintf("budget exceeded: $%.4f >= $%.4f", run.totalCost, maxBudget),
				IsError:      true,
				ErrorCode:    "budget_exceeded",
			}})
			break
		}

		// Proactive compaction: trigger at the effective context window
		// (full window minus reserves for the next response and the
		// compaction summary). A non-zero opts.CompactThreshold preserves
		// the legacy percent-of-window override so callers that already
		// tuned this value keep their behavior.
		compactLimit := conversation.AutoCompactTokenLimit(contextWindow, opts.MaxTokens)
		if opts.CompactThreshold > 0 {
			compactLimit = int(float64(contextWindow) * opts.CompactThreshold / 100.0)
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "source=legacy-override %", map[string]any{
				"compact_limit": compactLimit,
				"threshold":     opts.CompactThreshold,
				"window":        contextWindow,
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "source=auto", map[string]any{
				"compact_limit": compactLimit,
				"max_tokens":    opts.MaxTokens,
				"window":        contextWindow,
			})
		}
		cp := buildCompactParams(&opts, convDir)
		if run.cfg != nil && run.cfg.GetSessionMemory != nil {
			cp.getSessionMemory = run.cfg.GetSessionMemory
		}
		if run.cfg != nil && run.cfg.GetLastSummarizedEntryID != nil {
			cp.getLastSummarizedEntryID = run.cfg.GetLastSummarizedEntryID
		}
		if run.cfg != nil && run.cfg.ResetMemoryTracking != nil {
			cp.resetMemoryTracking = run.cfg.ResetMemoryTracking
		}
		b.compactIfNeeded(ctx, run, conv, hooks, contextWindow, compactLimit, cp)

		// Context-economy telemetry (family 4c): emit a context.pressure data
		// point once per turn after the compaction gate has run, so consumers
		// see the post-compaction token pressure for this turn. Nil-safe on
		// telemetry (disabled runs skip the GetContextUsage call entirely).
		if run.cfg != nil && run.cfg.Telemetry != nil {
			usage := conversation.GetContextUsage(conv, contextWindow)
			// R11: event name is carried by Event.Name; payload.kind removed.
			run.cfg.Telemetry.Event("context.pressure", map[string]any{
				"turn":           turn,
				"tokens_used":    usage.Tokens,
				"context_window": contextWindow,
				"percent":        usage.Percent,
				"estimated":      usage.Estimated,
				"compact_limit":  compactLimit,
			}, buildTelemCtx(run))
		}

		// Build stream options (sanitize before each API call to catch orphaned tool blocks)
		sanitized := conversation.SanitizeMessages(conv.Messages)

		// Prepend ephemeral initial messages from plugins and hooks. These are
		// never persisted to disk — they are constructed fresh per run and
		// prepended to the provider's message view only.
		//
		// Two categories (matching Claude Code's hook injection model):
		//   1. opts.InitialMessages — SessionStart hook output. Injected on
		//      every turn so the model always sees the plugin rules at the
		//      front of the conversation, not buried in the system prompt.
		//   2. hooks.OnInitialMessages — UserPromptSubmit hook output. Called
		//      fresh on each turn with the current prompt so per-turn
		//      reinforcement messages are always at the top of recent context.
		//
		// Both are wrapped in <system-reminder> by the session layer before
		// arriving here, matching Claude Code's wrapInSystemReminder format.
		var initialMsgs []types.LlmMessage
		initialMsgs = append(initialMsgs, opts.InitialMessages...)
		if hooks.OnInitialMessages != nil {
			perTurn := hooks.OnInitialMessages(run.requestID, opts.Prompt)
			initialMsgs = append(initialMsgs, perTurn...)
		}
		var messages []types.LlmMessage
		if len(initialMsgs) > 0 {
			messages = make([]types.LlmMessage, 0, len(initialMsgs)+len(sanitized))
			messages = append(messages, initialMsgs...)
			messages = append(messages, sanitized...)
		} else {
			messages = sanitized
		}

		streamOpts := types.LlmStreamOptions{
			Model:       model,
			System:      conv.System,
			Messages:    messages,
			Tools:       toolDefs,
			ServerTools: serverTools,
		}
		if opts.MaxTokens > 0 {
			streamOpts.MaxTokens = opts.MaxTokens
		}
		if opts.Thinking != nil {
			streamOpts.Thinking = opts.Thinking
		}

		// Build and emit the per-category context breakdown once per run, on
		// the first turn that has assembled stream options. See
		// runloop_context_breakdown.go for the build/emit + reconcile helpers.
		b.maybeEmitContextBreakdown(ctx, run, model, provider, &streamOpts)

		// Call provider with retry (with telemetry span)
		runIDCopy, turnCopy := run.requestID, turn
		// The RetryConfig (including the provider.retry / provider.fallback
		// telemetry closures, family 4d) is assembled in buildRetryConfig
		// (runloop_telemetry.go) to keep this file under the size cap.
		retryConfig := buildRetryConfig(run, &opts, model, runIDCopy, turnCopy)

		var telem TelemetryCollector
		if run.cfg != nil {
			telem = run.cfg.Telemetry
		}
		var llmSpan Span
		if telem != nil {
			llmSpan = telem.StartSpanCtx("llm.call", map[string]interface{}{
				"model": model,
				"turn":  turn,
			}, buildTelemCtx(run))
		}

		// Fire the before_provider_request extension hook immediately before
		// the outbound call. Observe-only — handler return values are ignored
		// and we never block the agent loop on this callback. Fires on every
		// turn, including fallback hops, so handlers see the real wire request
		// shape (post-fallback model, post-sanitization message list). Nil
		// callback means no extensions are interested; the conditional is a
		// pure read of an immutable struct field, so this is hot-path safe.
		if hooks.OnBeforeProviderRequest != nil {
			providerID := ""
			if provider != nil {
				providerID = provider.ID()
			}
			info := BeforeProviderRequestInfo{
				Provider:        providerID,
				Model:           streamOpts.Model,
				TurnNumber:      turn,
				MessageCount:    len(streamOpts.Messages),
				ToolCount:       len(streamOpts.Tools),
				HasSystemPrompt: streamOpts.System != "",
				MaxTokens:       streamOpts.MaxTokens,
			}
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "OnBeforeProviderRequest", map[string]any{
				"run_id":     run.requestID,
				"provider":   info.Provider,
				"model":      info.Model,
				"turn":       info.TurnNumber,
				"messages":   info.MessageCount,
				"tools":      info.ToolCount,
				"sys_prompt": info.HasSystemPrompt,
				"max_tokens": info.MaxTokens,
			})
			func() {
				// Defensive: a panicking handler must not crash the agent loop.
				// The hook is observe-only; recover, log, and proceed.
				defer func() {
					if r := recover(); r != nil {
						utils.LogWithFields(utils.LevelError, "backend.runloop", "OnBeforeProviderRequest panicked", map[string]any{
							"run_id": run.requestID,
							"panic":  r,
						})
					}
				}()
				hooks.OnBeforeProviderRequest(run.requestID, info)
			}()
		} else {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "OnBeforeProviderRequest: no callback registered, skipping", map[string]any{
				"run_id": run.requestID,
				"turn":   turn,
			})
		}

		// Stash the run's telemetry correlation block on the streaming context
		// so the provider stream-idle wrapper (sse_idle.go) can attribute
		// provider.stall / provider.stream_summary events to the originating
		// conversation. buildTelemCtx carries session_id / conversation_id /
		// run_id / extension — exactly what the forensics "provider trouble"
		// scoring joins on. Nil-safe: WithTelemetryCorrelation returns ctx
		// unchanged when the block is nil.
		streamCtx := providers.WithTelemetryCorrelation(ctx, buildTelemCtx(run))

		events, errc := providers.WithRetry(streamCtx, provider, streamOpts, retryConfig)

		// Process stream events
		assistantBlocks, stopReason, turnUsage, streamErr := b.processStream(ctx, run, events, errc)

		// End LLM telemetry span
		if llmSpan != nil {
			errStr := ""
			if streamErr != nil {
				errStr = streamErr.Error()
			}
			// R7: snake_case telemetry payload keys.
			llmSpan.End(map[string]interface{}{"stop_reason": stopReason}, errStr)
		}

		if streamErr != nil {
			if ctx.Err() != nil {
				utils.LogWithFields(utils.LevelWarn, "backend.runloop", "stream cancelled", map[string]any{
					"run_id": run.requestID,
					"turn":   turn,
				})
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
			// G33: prompt_too_long / overloaded -- 3-step cascade then retry (capped)
			errMsg := streamErr.Error()
			if (strings.Contains(errMsg, "prompt_too_long") || strings.Contains(errMsg, "prompt is too long") ||
				strings.Contains(errMsg, "overloaded_error")) && turn > 0 {
				promptTooLongRetries++
				utils.LogWithFields(utils.LevelDebug, "backend.runloop", "prompt_too_long: /", map[string]any{
					"retry":                       promptTooLongRetries,
					"max_prompt_too_long_retries": maxPromptTooLongRetries,
					"run_id":                      run.requestID,
					"turn":                        turn,
				})
				if promptTooLongRetries > maxPromptTooLongRetries {
					utils.LogWithFields(utils.LevelError, "backend.runloop", "prompt_too_long: retries exhausted, giving up", map[string]any{
						"max_prompt_too_long_retries": maxPromptTooLongRetries,
						"run_id":                      run.requestID,
					})
					b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
						ErrorMessage: fmt.Sprintf("Context too large after %d compaction attempts. Start a new conversation or manually reduce context.", maxPromptTooLongRetries),
						IsError:      true,
						ErrorCode:    "compaction_failed",
					}})
					b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
					return
				}
				b.compactReactive(ctx, run, conv, hooks, contextWindow, promptTooLongRetries, cp)
				continue // retry the turn after compaction
			}
			cause := ""
			if pe, ok := streamErr.(*providers.ProviderError); ok && pe.Cause != nil {
				cause = fmt.Sprintf(" cause=%v", pe.Cause)
			}
			utils.LogWithFields(utils.LevelError, "backend.runloop", "stream error", map[string]any{
				"run_id": run.requestID,
				"turn":   turn,
				"error":  utils.ErrStr(streamErr),
				"cause":  cause,
			})
			b.emitError(run, streamErr)
			b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
			return
		}

		// Stream truncated (no stop reason) -- emit reset so consumers
		// discard partial text, then retry the turn (capped at 3
		// consecutive).
		if stopReason == "" {
			truncationRetries++
			maxTruncation := 3
			if run.cfg != nil && run.cfg.Timeouts != nil {
				maxTruncation = run.cfg.Timeouts.TruncationRetryLimit()
			}
			if truncationRetries > maxTruncation {
				utils.LogWithFields(utils.LevelError, "backend.runloop", "stream truncated consecutive times, giving up", map[string]any{
					"truncation_retries": truncationRetries,
					"run_id":             run.requestID,
				})
				b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
					ErrorMessage: fmt.Sprintf("Stream truncated %d consecutive times. The provider may be experiencing issues.", truncationRetries),
					IsError:      true,
					ErrorCode:    "stream_truncated",
				}})
				b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
				return
			}
			utils.LogWithFields(utils.LevelWarn, "backend.runloop", "stream truncated (no stop reason): /3, retrying", map[string]any{
				"run_id":  run.requestID,
				"turn":    turn,
				"attempt": truncationRetries,
			})
			b.emit(run, types.NormalizedEvent{Data: &types.StreamResetEvent{}})
			continue
		}

		// Stream succeeded with a valid stop reason -- reset retry counters.
		if promptTooLongRetries > 0 || truncationRetries > 0 || run.compactionsWithoutProgress > 0 {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "counters reset", map[string]any{
				"prompt_too_long":              promptTooLongRetries,
				"truncation":                   truncationRetries,
				"compactions_without_progress": run.compactionsWithoutProgress,
			})
		}
		promptTooLongRetries = 0
		truncationRetries = 0
		run.compactionsWithoutProgress = 0

		// Track usage and cost
		currentTurnOutputTokens := 0
		if turnUsage != nil {
			costUsd := computeCost(model, *turnUsage)
			run.totalCost += costUsd
			conversation.UpdateCost(conv, costUsd)

			// Accumulate per-run token totals for TaskCompleteEvent.Usage.
			run.cumulativeInputTokens += turnUsage.InputTokens
			run.cumulativeCacheReadTokens += turnUsage.CacheReadInputTokens
			run.cumulativeCacheCreateTokens += turnUsage.CacheCreationInputTokens

			// Emit usage event with TOTAL input tokens (including cached) so
			// consumers can compute accurate context percentage
			totalIn := turnUsage.InputTokens + turnUsage.CacheReadInputTokens + turnUsage.CacheCreationInputTokens
			outTok := turnUsage.OutputTokens
			cacheRead := turnUsage.CacheReadInputTokens
			cacheCreate := turnUsage.CacheCreationInputTokens
			b.emit(run, types.NormalizedEvent{Data: &types.UsageEvent{
				Usage: types.UsageData{
					InputTokens:              &totalIn,
					OutputTokens:             &outTok,
					CacheReadInputTokens:     &cacheRead,
					CacheCreationInputTokens: &cacheCreate,
				},
			}})

			// Reconcile the context breakdown with the provider-reported input
			// total on the FIRST usage event only. See
			// runloop_context_breakdown.go.
			b.maybeReconcileContextBreakdown(run, totalIn, cacheRead, cacheCreate)

			// Accumulate output tokens for the early-stop continuation
			// decision. Done unconditionally — the feature gates itself on
			// `earlyStop.enabled` inside maybeContinueEarlyStop, but the
			// counter must stay in sync across turns so it's correct when
			// a harness hook flips ForceContinue on later in the run.
			currentTurnOutputTokens = outTok
			run.cumulativeOutputTokens += outTok
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "earlyStop: tokens", map[string]any{
				"run_id":   run.requestID,
				"turn":     turn,
				"turn_out": outTok,
				"cum_out":  run.cumulativeOutputTokens,
			})
		}

		// Add assistant message to conversation
		if len(assistantBlocks) > 0 {
			var llmUsage types.LlmUsage
			if turnUsage != nil {
				llmUsage = *turnUsage
			}
			// Persist-thinking gate (issue #158): when persistThinking is off,
			// retain a bare {"type":"thinking"} block without the reasoning
			// text. Never affects provider re-submission (SanitizeMessages
			// always strips thinking). See blocksForPersistence.
			blocksToPersist := b.blocksForPersistence(run, assistantBlocks)
			conversation.AddAssistantMessage(conv, blocksToPersist, llmUsage)
			conversation.SetAssistantMeta(conv, model, stopReason)
			// Persist immediately so the assistant turn survives mid-loop crashes.
			// The end-of-turn Save() below remains as the canonical write that
			// also captures stop-reason transitions.
			if err := conversation.Save(conv, ""); err != nil {
				utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after AddAssistantMessage", map[string]any{
					"error": utils.ErrStr(err),
				})
			}
		}

		// Fire turn_end hook
		if hooks.OnTurnEnd != nil {
			if _, err := runHookCtx(ctx, func() struct{} {
				hooks.OnTurnEnd(run.requestID, turn)
				return struct{}{}
			}); err != nil {
				utils.LogWithFields(utils.LevelWarn, "backend.runloop", "turn_end hook cancelled", map[string]any{
					"run_id": run.requestID,
					"turn":   turn,
				})
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
		}

		// Handle stop reason. The per-stop-reason switch lives in
		// dispatchStopReason (runloop_stop_reason.go) to keep this file under
		// the size cap. A true return means the run terminated (a
		// TaskCompleteEvent + exit was already emitted, or a cancellation was
		// handled) and runLoop should return; false means keep iterating.
		if b.dispatchStopReason(ctx, run, conv, hooks, opts, earlyStop, assistantBlocks, stopReason, currentTurnOutputTokens, turn, maxTurns, convDir) {
			return
		}
	}

	// Exceeded max turns
	if err := conversation.Save(conv, ""); err != nil {
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation", map[string]any{
			"error": utils.ErrStr(err),
		})
	}

	elapsed := time.Since(run.startTime).Milliseconds()
	b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Result:            fmt.Sprintf("Reached max turns (%d)", maxTurns),
		LastText:          run.lastNonEmptyResultText,
		CostUsd:           run.totalCost,
		DurationMs:        elapsed,
		NumTurns:          turn,
		ConversationTurns: conversation.CountUserPrompts(conv),
		SessionID:         conv.ID,
		Usage:             cumulativeUsage(run),
	}})
	utils.LogWithFields(utils.LevelWarn, "backend.runloop", "max turns exceeded: / cost=$", map[string]any{
		"run_id":     run.requestID,
		"turns":      turn,
		"max_turns":  maxTurns,
		"total_cost": run.totalCost,
	})
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}
