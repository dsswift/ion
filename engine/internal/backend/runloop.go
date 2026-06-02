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
	defer b.removeRun(run.requestID)

	// Snapshot per-run hooks once. Nil cfg means "no hooks" -- the empty
	// RunHooks struct has nil callback fields, which the call sites below
	// already guard against.
	var hooks RunHooks
	if run.cfg != nil {
		hooks = run.cfg.Hooks
	}

	// Resolve the effective early-stop continuation config for this run.
	// Defaults < engine.json < RunOptions < sub-agent gate. Log the final
	// snapshot once at INFO so a reader can reconstruct the decision path
	// from logs alone (per CLAUDE.md logging policy).
	earlyStop := mergeEarlyStopConfig(opts, run.cfg)
	utils.Info("ApiBackend", fmt.Sprintf(
		"earlyStop: runID=%s enabled=%v budget=%d threshold=%d cap=%d diminishingDelta=%d source=%s isSubagent=%v",
		run.requestID, earlyStop.enabled, earlyStop.budget, earlyStop.thresholdPct,
		earlyStop.maxContinuations, earlyStop.diminishingDelta, earlyStop.source, opts.IsSubagent,
	))

	// Resolve provider
	model := opts.Model
	if model == "" {
		msg := "no model configured: set defaultModel in ~/.ion/engine.json or pass --model. See docs/configuration/engine-json.md."
		utils.Error("ApiBackend", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "no_model_configured",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}

	provider := b.resolveProvider(model)
	if provider == nil && run.cfg != nil && run.cfg.DefaultModel != "" && run.cfg.DefaultModel != model {
		// Graceful degradation: the requested model (e.g. an unrecognized
		// tier alias like "standard") didn't resolve. Fall back to the
		// engine's default model instead of hard-failing.
		utils.Warn("ApiBackend", fmt.Sprintf("model %q not found, falling back to default %q", model, run.cfg.DefaultModel))
		model = run.cfg.DefaultModel
		opts.Model = model
		provider = b.resolveProvider(model)
	}
	if provider == nil {
		utils.Error("ApiBackend", fmt.Sprintf("no provider for model %q", model))
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf("no provider found for model %q", model),
			ErrorCode:    "invalid_model",
		}})
		b.emitError(run, fmt.Errorf("no provider found for model %q", model))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}

	// Load or create conversation
	conv, convErr := loadOrCreateConversation(opts, model)
	if convErr != nil {
		msg := fmt.Sprintf("Failed to load conversation %s: %v. Your conversation history is safe on disk — please retry.", opts.SessionID, convErr)
		utils.Error("ApiBackend", msg)
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: msg,
			ErrorCode:    "conversation_load_failed",
		}})
		b.emitError(run, fmt.Errorf("%s", msg))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}
	run.conv = conv

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

	// Add user message (using potentially-rewritten prompt). When the client
	// supplied pre-encoded image attachments, build a structured content
	// block list so the provider sends them as native multimodal content
	// (Anthropic image blocks, OpenAI image_url, Gemini inlineData, Bedrock
	// image content). Engine has no opinion on any client-side marker
	// syntax inside opts.Prompt — bytes ride in opts.Attachments.
	if len(opts.Attachments) > 0 {
		conversation.AddUserMessage(conv, buildUserContentBlocks(opts.Prompt, opts.Attachments))
	} else {
		conversation.AddUserMessage(conv, opts.Prompt)
	}
	// Persist immediately: if the engine dies mid-stream, the user prompt
	// must survive so the user does not lose what they just typed.
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save conversation after AddUserMessage: "+err.Error())
	}

	// Resolve limits. Engine ships unopinionated: maxTurns/maxBudget <= 0 means
	// "no cap" -- the agent loop runs until the LLM emits a terminal stop or
	// the caller cancels. Harness engineers cap via RunOptions, engine.json
	// limits, or per-dispatch options.
	maxTurns := opts.MaxTurns
	maxBudget := opts.MaxBudgetUsd

	// Build tool definitions (built-in + external/MCP + capabilities + filters)
	toolDefs, serverTools := b.buildToolDefs(run, opts, provider)

	// Resolve context window for compaction checks
	contextWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil {
		contextWindow = info.ContextWindow
		utils.Log("ApiBackend", fmt.Sprintf("context window: model=%s window=%d (from registry)", model, contextWindow))
	} else {
		utils.Warn("ApiBackend", fmt.Sprintf("context window: model=%s window=%d (fallback, model not in registry)", model, contextWindow))
	}

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
			utils.Warn("ApiBackend", fmt.Sprintf("run cancelled: runID=%s turns=%d cost=$%.4f", run.requestID, turn, run.totalCost))
			b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
			return
		}

		// Check for steer messages
		select {
		case steerMsg := <-run.steerCh:
			conversation.AddUserMessage(run.conv, steerMsg)
			if err := conversation.Save(run.conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after steer: "+err.Error())
			}
			utils.Log("ApiBackend", "steer message injected into conversation")
		default:
			// no steer message, continue normally
		}

		// Increment turn counter before firing turn_start, so the first turn
		// reports turn=1 (matching TS behavior).
		turn++
		run.turnCount.Store(int64(turn))

		// Wind-down: warn the LLM 2 turns before max so it can wrap up
		if maxTurns > 4 && turn == maxTurns-2 {
			b.injectSystemMessage(run, conv, hooks, opts, "turn_limit_warning",
				"[SYSTEM] You are approaching your turn limit. You have 2 turns remaining. Wrap up your current work, summarize what you've accomplished and what remains, then return your response.",
				turn, maxTurns)
			utils.Log("ApiBackend", fmt.Sprintf("wind-down injected: runID=%s turn=%d/%d", run.requestID, turn, maxTurns))
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
				utils.Info("PlanMode", fmt.Sprintf("run=%s reminder injected turn=%d lastTurn=%d interval=%d gate=%s msgCount=%d source=%s", run.requestID, turn, lastReminderTurn, planModeReminderInterval, gate, msgCount, source))
			} else {
				utils.Debug("PlanMode", fmt.Sprintf("run=%s reminder throttled turn=%d lastTurn=%d nextAt=%d", run.requestID, turn, lastReminderTurn, lastReminderTurn+planModeReminderInterval))
			}
		}

		// Fire turn_start hook
		if hooks.OnTurnStart != nil {
			if _, err := runHookCtx(ctx, func() struct{} {
				hooks.OnTurnStart(run.requestID, turn)
				return struct{}{}
			}); err != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("turn_start hook cancelled: runID=%s turn=%d", run.requestID, turn))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
		}

		// Check budget
		if maxBudget > 0 && run.totalCost >= maxBudget {
			utils.Warn("ApiBackend", fmt.Sprintf("budget exceeded: runID=%s cost=$%.4f budget=$%.4f", run.requestID, run.totalCost, maxBudget))
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
			utils.Debug("ApiBackend", fmt.Sprintf("compactLimit=%d source=legacy-override threshold=%.0f%% window=%d", compactLimit, opts.CompactThreshold, contextWindow))
		} else {
			utils.Debug("ApiBackend", fmt.Sprintf("compactLimit=%d source=auto maxTokens=%d window=%d", compactLimit, opts.MaxTokens, contextWindow))
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

		// Build stream options (sanitize before each API call to catch orphaned tool blocks)
		streamOpts := types.LlmStreamOptions{
			Model:       model,
			System:      conv.System,
			Messages:    conversation.SanitizeMessages(conv.Messages),
			Tools:       toolDefs,
			ServerTools: serverTools,
		}
		if opts.MaxTokens > 0 {
			streamOpts.MaxTokens = opts.MaxTokens
		}
		if opts.Thinking != nil {
			streamOpts.Thinking = opts.Thinking
		}

		// Call provider with retry (with telemetry span)
		runIDCopy, turnCopy := run.requestID, turn
		retryConfig := &providers.RetryConfig{
			MaxRetries:    opts.MaxRetries,
			FallbackChain: opts.FallbackChain,
			Persistent:    opts.Persistent,
			OnRetryWait: func(attempt, delayMs int, pe *providers.ProviderError) {
				cause := ""
				if pe != nil && pe.Cause != nil {
					cause = fmt.Sprintf(" cause=%v", pe.Cause)
				}
				code := ""
				if pe != nil {
					code = pe.Code
				}
				utils.Warn("ApiBackend", fmt.Sprintf(
					"provider retry: runID=%s turn=%d attempt=%d delay=%dms code=%s err=%q%s",
					runIDCopy, turnCopy, attempt, delayMs, code, fmt.Sprint(pe), cause,
				))
			},
			OnFallback: func(fromModel, toModel string, hop int) {
				utils.Warn("ApiBackend", fmt.Sprintf(
					"model fallback: runID=%s turn=%d hop=%d %s -> %s",
					runIDCopy, turnCopy, hop, fromModel, toModel,
				))
			},
		}

		var telem TelemetryCollector
		if run.cfg != nil {
			telem = run.cfg.Telemetry
		}
		var llmSpan Span
		if telem != nil {
			llmSpan = telem.StartSpan("llm.call", map[string]interface{}{
				"model": model,
				"turn":  turn,
			})
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
			utils.Debug("ApiBackend", fmt.Sprintf(
				"OnBeforeProviderRequest: runID=%s provider=%s model=%s turn=%d messages=%d tools=%d sysPrompt=%v maxTokens=%d",
				run.requestID, info.Provider, info.Model, info.TurnNumber,
				info.MessageCount, info.ToolCount, info.HasSystemPrompt, info.MaxTokens,
			))
			func() {
				// Defensive: a panicking handler must not crash the agent loop.
				// The hook is observe-only; recover, log, and proceed.
				defer func() {
					if r := recover(); r != nil {
						utils.Error("ApiBackend", fmt.Sprintf(
							"OnBeforeProviderRequest panicked: runID=%s panic=%v", run.requestID, r,
						))
					}
				}()
				hooks.OnBeforeProviderRequest(run.requestID, info)
			}()
		} else {
			utils.Debug("ApiBackend", fmt.Sprintf(
				"OnBeforeProviderRequest: no callback registered, skipping (runID=%s turn=%d)",
				run.requestID, turn,
			))
		}

		events, errc := providers.WithRetry(ctx, provider, streamOpts, retryConfig)

		// Process stream events
		assistantBlocks, stopReason, turnUsage, streamErr := b.processStream(ctx, run, events, errc)

		// End LLM telemetry span
		if llmSpan != nil {
			errStr := ""
			if streamErr != nil {
				errStr = streamErr.Error()
			}
			llmSpan.End(map[string]interface{}{"stopReason": stopReason}, errStr)
		}

		if streamErr != nil {
			if ctx.Err() != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("stream cancelled: runID=%s turn=%d", run.requestID, turn))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
			// G33: prompt_too_long / overloaded -- 3-step cascade then retry (capped)
			errMsg := streamErr.Error()
			if (strings.Contains(errMsg, "prompt_too_long") || strings.Contains(errMsg, "prompt is too long") ||
				strings.Contains(errMsg, "overloaded_error")) && turn > 0 {
				promptTooLongRetries++
				utils.Debug("ApiBackend", fmt.Sprintf("prompt_too_long: retry=%d/%d runID=%s turn=%d", promptTooLongRetries, maxPromptTooLongRetries, run.requestID, turn))
				if promptTooLongRetries > maxPromptTooLongRetries {
					utils.Error("ApiBackend", fmt.Sprintf("prompt_too_long: %d retries exhausted, giving up: runID=%s", maxPromptTooLongRetries, run.requestID))
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
			utils.Error("ApiBackend", fmt.Sprintf("stream error: runID=%s turn=%d err=%s%s", run.requestID, turn, streamErr.Error(), cause))
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
				utils.Error("ApiBackend", fmt.Sprintf("stream truncated %d consecutive times, giving up: runID=%s", truncationRetries, run.requestID))
				b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
					ErrorMessage: fmt.Sprintf("Stream truncated %d consecutive times. The provider may be experiencing issues.", truncationRetries),
					IsError:      true,
					ErrorCode:    "stream_truncated",
				}})
				b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
				return
			}
			utils.Warn("ApiBackend", fmt.Sprintf("stream truncated (no stop reason): runID=%s turn=%d attempt=%d/3, retrying", run.requestID, turn, truncationRetries))
			b.emit(run, types.NormalizedEvent{Data: &types.StreamResetEvent{}})
			continue
		}

		// Stream succeeded with a valid stop reason -- reset retry counters.
		if promptTooLongRetries > 0 || truncationRetries > 0 || run.compactionsWithoutProgress > 0 {
			utils.Debug("ApiBackend", fmt.Sprintf("counters reset: promptTooLong=%d truncation=%d compactionsWithoutProgress=%d", promptTooLongRetries, truncationRetries, run.compactionsWithoutProgress))
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

			// Accumulate output tokens for the early-stop continuation
			// decision. Done unconditionally — the feature gates itself on
			// `earlyStop.enabled` inside maybeContinueEarlyStop, but the
			// counter must stay in sync across turns so it's correct when
			// a harness hook flips ForceContinue on later in the run.
			currentTurnOutputTokens = outTok
			run.cumulativeOutputTokens += outTok
			utils.Debug("ApiBackend", fmt.Sprintf(
				"earlyStop: tokens: runID=%s turn=%d turnOut=%d cumOut=%d",
				run.requestID, turn, outTok, run.cumulativeOutputTokens,
			))
		}

		// Add assistant message to conversation
		if len(assistantBlocks) > 0 {
			var llmUsage types.LlmUsage
			if turnUsage != nil {
				llmUsage = *turnUsage
			}
			conversation.AddAssistantMessage(conv, assistantBlocks, llmUsage)
			conversation.SetAssistantMeta(conv, model, stopReason)
			// Persist immediately so the assistant turn survives mid-loop crashes.
			// The end-of-turn Save() below remains as the canonical write that
			// also captures stop-reason transitions.
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after AddAssistantMessage: "+err.Error())
			}
		}

		// Fire turn_end hook
		if hooks.OnTurnEnd != nil {
			if _, err := runHookCtx(ctx, func() struct{} {
				hooks.OnTurnEnd(run.requestID, turn)
				return struct{}{}
			}); err != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("turn_end hook cancelled: runID=%s turn=%d", run.requestID, turn))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
		}

		// Handle stop reason
		switch stopReason {
		case "end_turn", "stop":
			// Extract final text for task_complete
			var resultText string
			for _, block := range assistantBlocks {
				if block.Type == "text" {
					resultText += block.Text
				}
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
					utils.Log("ApiBackend", "failed to save conversation after early-stop continuation: "+err.Error())
				}
				continue
			}

			// Save conversation
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
			}

			elapsed := time.Since(run.startTime).Milliseconds()
			utils.Info("ApiBackend", fmt.Sprintf("run complete: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, turn, run.totalCost, elapsed, conv.ID))
			b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Result:     resultText,
				CostUsd:    run.totalCost,
				DurationMs: elapsed,
				NumTurns:   turn,
				SessionID:  conv.ID,
			}})
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return

		case "tool_use":
			// Extract tool_use blocks
			var toolUseBlocks []types.LlmContentBlock
			for _, block := range assistantBlocks {
				if block.Type == "tool_use" {
					toolUseBlocks = append(toolUseBlocks, block)
				}
			}

			if len(toolUseBlocks) == 0 {
				// No tool calls despite tool_use stop reason; treat as end_turn
				utils.Warn("ApiBackend", fmt.Sprintf("tool_use stop reason with zero tool blocks: runID=%s turn=%d", run.requestID, turn))
				continue
			}

			// Execute tools in parallel
			results, err := b.executeTools(ctx, run, toolUseBlocks, opts.ProjectPath)
			if err != nil {
				if ctx.Err() != nil {
					utils.Warn("ApiBackend", fmt.Sprintf("tool execution cancelled: runID=%s", run.requestID))
					b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
					return
				}
				utils.Error("ApiBackend", fmt.Sprintf("tool execution failed: runID=%s err=%s", run.requestID, err.Error()))
				b.emitError(run, err)
				b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
				return
			}

			// Check for cancellation even when tools completed successfully.
			// Tool goroutines return nil unconditionally, so executeTools may
			// return (results, nil) even after the context was cancelled.
			// Without this check the loop would add results and start a new
			// LLM turn before noticing the abort at the top of the loop.
			if ctx.Err() != nil {
				utils.Warn("ApiBackend", fmt.Sprintf("run cancelled after tool execution: runID=%s", run.requestID))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}

			// If ExitPlanMode was triggered, wrap up the run now.
			run.mu.Lock()
			exiting := run.exitPlanMode
			denials := run.permissionDenials
			run.mu.Unlock()
			if exiting {
				if err := conversation.Save(conv, ""); err != nil {
					utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
				}
				elapsed := time.Since(run.startTime).Milliseconds()
				utils.Info("ApiBackend", fmt.Sprintf("plan mode exited: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, turn, run.totalCost, elapsed, conv.ID))
				b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
					Result:            "Plan mode exited.",
					CostUsd:           run.totalCost,
					DurationMs:        elapsed,
					NumTurns:          turn,
					SessionID:         conv.ID,
					PermissionDenials: denials,
				}})
				b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
				return
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
				utils.Log("ApiBackend", "failed to save conversation after AddToolResults: "+err.Error())
			}

			// Reset early-stop continuation counters on tool_use: the model
			// is making forward progress through tools, so the next end_turn
			// gets a fresh cap. Without this reset a long multi-tool run
			// (e.g. a 10-step refactor) would consume the continuation
			// budget on tool turns that produce little output text.
			if run.continuationCount != 0 || run.lastContinuationDelta != 0 {
				utils.Debug("ApiBackend", fmt.Sprintf(
					"earlyStop: reset continuation counters on tool_use: runID=%s turn=%d prevCount=%d",
					run.requestID, turn, run.continuationCount,
				))
				run.continuationCount = 0
				run.lastContinuationDelta = 0
			}

		case "max_tokens":
			// Detect whether a tool_use block was truncated. When the stream
			// is cut mid-tool-call the input JSON is unparseable and gets
			// coerced to {} in processStream. Tell the model what happened
			// so it can retry with a smaller payload or split the work,
			// rather than blindly repeating the same too-large call.
			truncatedTool := ""
			for _, block := range assistantBlocks {
				if block.Type == "tool_use" && len(block.Input) == 0 && block.Name != "" {
					truncatedTool = block.Name
					break
				}
			}

			if truncatedTool != "" {
				utils.Warn("ApiBackend", fmt.Sprintf("max_tokens truncated tool_use (tool=%s): runID=%s turn=%d", truncatedTool, run.requestID, turn))
				b.injectSystemMessage(run, conv, hooks, opts, "max_token_continue",
					fmt.Sprintf("Your previous response was cut off by the output token limit while generating the input for tool '%s'. The tool call was NOT executed. Break the work into smaller pieces — for example, write the file in multiple parts using Bash with heredocs or sequential Write calls.", truncatedTool),
					turn, maxTurns)
			} else {
				utils.Info("ApiBackend", fmt.Sprintf("max_tokens reached, continuing: runID=%s turn=%d", run.requestID, turn))
				b.injectSystemMessage(run, conv, hooks, opts, "max_token_continue",
					"Continue from where you left off.",
					turn, maxTurns)
			}

		default:
			// Unknown stop reason; break the loop
			utils.Log("ApiBackend", "unexpected stop reason: "+stopReason)
			b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
			return
		}
	}

	// Exceeded max turns
	if err := conversation.Save(conv, ""); err != nil {
		utils.Log("ApiBackend", "failed to save conversation: "+err.Error())
	}

	elapsed := time.Since(run.startTime).Milliseconds()
	b.emit(run, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Result:     fmt.Sprintf("Reached max turns (%d)", maxTurns),
		CostUsd:    run.totalCost,
		DurationMs: elapsed,
		NumTurns:   turn,
		SessionID:  conv.ID,
	}})
	utils.Warn("ApiBackend", fmt.Sprintf("max turns exceeded: runID=%s turns=%d/%d cost=$%.4f", run.requestID, turn, maxTurns, run.totalCost))
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// injectSystemMessage handles all engine-injected steering messages.
// It checks disable flags, fires the system_inject hook, and either
// adds a transient message (suppress mode) or persists it normally.
func (b *ApiBackend) injectSystemMessage(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	kind, defaultText string,
	turn, maxTurns int,
) {
	// Check per-injection disable flag
	switch kind {
	case "plan_mode_reminder":
		if opts.DisablePlanModeReminder {
			return
		}
	case "turn_limit_warning":
		if opts.DisableTurnLimitWarning {
			return
		}
	case "max_token_continue":
		if opts.DisableMaxTokenContinue {
			return
		}
	case earlyStopContinueKind:
		if opts.DisableEarlyStopContinue {
			utils.Debug("ApiBackend", fmt.Sprintf(
				"earlyStop: injection suppressed by DisableEarlyStopContinue: runID=%s turn=%d",
				run.requestID, turn,
			))
			return
		}
	}

	// Fire hook if registered
	text := defaultText
	if hooks.OnSystemInject != nil {
		hookText, suppress := hooks.OnSystemInject(kind, defaultText, turn, maxTurns)
		if suppress {
			return
		}
		if hookText != "" {
			text = hookText
		}
	}

	// Add message: transient (in-memory only) or persistent
	if opts.SuppressSystemMessages {
		conversation.AddTransientUserMessage(conv, text)
	} else {
		conversation.AddUserMessage(conv, text)
		if err := conversation.Save(conv, ""); err != nil {
			utils.Log("ApiBackend", "failed to save conversation after system inject: "+err.Error())
		}
	}
}
