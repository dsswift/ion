package backend

import (
	"context"
	"fmt"
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
	conv := loadOrCreateConversation(opts, model)
	run.conv = conv

	// Build system prompt (may rewrite opts.Prompt and opts.PlanModeTools)
	conv.System = buildSystemPrompt(&opts, conv, hooks, run.requestID)

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

		// Plan mode: inject sparse reminder on turn 2+ so the LLM
		// doesn't drift from plan-mode constraints mid-conversation.
		if run.planMode && turn > 1 {
			b.injectSystemMessage(run, conv, hooks, opts, "plan_mode_reminder",
				"[SYSTEM] "+buildPlanModeSparseReminder(run.planFilePath),
				turn, maxTurns)
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

		// Context compaction cascade at threshold (config override via opts.CompactThreshold)
		threshold := compactThreshold
		if opts.CompactThreshold > 0 {
			threshold = int(opts.CompactThreshold)
		}
		b.compactIfNeeded(run, conv, hooks, contextWindow, threshold)

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
				b.compactReactive(run, conv, hooks, promptTooLongRetries)
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

		// Stream truncated (no stop reason) -- emit reset so desktop discards
		// partial text, then retry the turn (capped at 3 consecutive).
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
		promptTooLongRetries = 0
		truncationRetries = 0

		// Track usage and cost
		if turnUsage != nil {
			costUsd := computeCost(model, *turnUsage)
			run.totalCost += costUsd
			conversation.UpdateCost(conv, costUsd)

			// Emit usage event with TOTAL input tokens (including cached) so
			// desktop shows accurate context percentage
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
		}

		// Add assistant message to conversation
		if len(assistantBlocks) > 0 {
			var llmUsage types.LlmUsage
			if turnUsage != nil {
				llmUsage = *turnUsage
			}
			conversation.AddAssistantMessage(conv, assistantBlocks, llmUsage)
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

			// Add tool results to conversation
			conversation.AddToolResults(conv, results)
			// Persist immediately so tool history survives mid-multi-turn crashes.
			if err := conversation.Save(conv, ""); err != nil {
				utils.Log("ApiBackend", "failed to save conversation after AddToolResults: "+err.Error())
			}

		case "max_tokens":
			utils.Info("ApiBackend", fmt.Sprintf("max_tokens reached, continuing: runID=%s turn=%d", run.requestID, turn))
			b.injectSystemMessage(run, conv, hooks, opts, "max_token_continue",
				"Continue from where you left off.",
				turn, maxTurns)

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
