package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/insights"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"golang.org/x/sync/errgroup"
)

// activeRun tracks the state of a single in-flight agent loop.
type activeRun struct {
	mu                 sync.Mutex
	requestID          string
	conv               *conversation.Conversation
	cancel             context.CancelFunc
	turnCount          int
	totalCost          float64
	startTime          time.Time
	steerCh            chan string
	exitPlanMode       bool                     // set when ExitPlanMode tool is called during plan mode
	permissionDenials  []types.PermissionDenial // tools intercepted/denied (e.g. ExitPlanMode sentinel)
	planMode           bool                     // true when this run is in plan mode
	planFilePath       string                   // only writable file during plan mode
}

// ApiBackend is the direct-API backend that runs an agentic loop against
// an LLM provider, executing tools and managing conversation state.
type ApiBackend struct {
	mu         sync.Mutex
	activeRuns map[string]*activeRun

	onNormalized func(string, types.NormalizedEvent)
	onExit       func(string, *int, *string, string)
	onError      func(string, error)

	onToolCall    func(info ToolCallInfo) (*ToolCallResult, error)
	onPerToolHook func(toolName string, info interface{}, phase string) (interface{}, error)

	// Hook callbacks wired by session manager
	onTurnStart            func(runID string, turnNumber int)
	onTurnEnd              func(runID string, turnNumber int)
	onBeforePrompt         func(runID string, prompt string) (string, string)
	onPlanModePrompt       func(planFilePath string) (string, []string)
	onSessionBeforeCompact func(runID string) bool
	onSessionCompact       func(runID string, info interface{})
	onFileChanged          func(runID string, path string, action string)
	onPermissionRequest    func(runID string, info interface{})
	onPermissionDenied     func(runID string, info interface{})

	// Security
	permEngine   *permissions.Engine
	sandboxCfg   *sandbox.Config
	authResolver *auth.Resolver
	securityCfg  *types.SecurityConfig

	// External tools (MCP)
	externalTools []types.LlmToolDef
	mcpToolRouter func(name string, input map[string]interface{}) (string, bool, error)

	telemetry TelemetryCollector
}

// NewApiBackend creates an ApiBackend ready for use.
func NewApiBackend() *ApiBackend {
	return &ApiBackend{
		activeRuns: make(map[string]*activeRun),
	}
}

// OnNormalized registers the callback for normalized events.
func (b *ApiBackend) OnNormalized(fn func(string, types.NormalizedEvent)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onNormalized = fn
}

// OnExit registers the callback for run exit events.
func (b *ApiBackend) OnExit(fn func(string, *int, *string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onExit = fn
}

// OnError registers the callback for run errors.
func (b *ApiBackend) OnError(fn func(string, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onError = fn
}

// SetOnToolCall registers a hook called before each tool execution.
// Returning a non-nil ToolCallResult with Block=true prevents the tool call.
func (b *ApiBackend) SetOnToolCall(fn func(ToolCallInfo) (*ToolCallResult, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onToolCall = fn
}

// SetOnPerToolHook registers a hook called before and after each tool execution.
func (b *ApiBackend) SetOnPerToolHook(fn func(string, interface{}, string) (interface{}, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onPerToolHook = fn
}

// SetTelemetry attaches a telemetry collector.
func (b *ApiBackend) SetTelemetry(t TelemetryCollector) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.telemetry = t
}

// SetPermissions attaches a permission engine for tool call checks.
func (b *ApiBackend) SetPermissions(e *permissions.Engine) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.permEngine = e
}

// SetSandboxConfig attaches sandbox configuration for bash wrapping.
func (b *ApiBackend) SetSandboxConfig(cfg *sandbox.Config) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sandboxCfg = cfg
}

// SetAuthResolver attaches an auth resolver for API key resolution.
func (b *ApiBackend) SetAuthResolver(r *auth.Resolver) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.authResolver = r
}

// SetExternalTools sets MCP tool definitions and router for execution.
func (b *ApiBackend) SetExternalTools(defs []types.LlmToolDef, router func(string, map[string]interface{}) (string, bool, error)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.externalTools = defs
	b.mcpToolRouter = router
}

// SetTurnHooks wires turn lifecycle callbacks.
func (b *ApiBackend) SetTurnHooks(onStart func(string, int), onEnd func(string, int)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onTurnStart = onStart
	b.onTurnEnd = onEnd
}

// SetBeforePrompt wires the prompt rewrite hook. The callback receives the
// run ID and the current prompt, and returns an optional rewritten prompt and
// an optional system prompt addition (either may be empty for no change).
func (b *ApiBackend) SetBeforePrompt(fn func(string, string) (string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onBeforePrompt = fn
}

// SetPlanModePromptHook wires the plan mode prompt hook. The callback receives
// the plan file path and returns an optional custom prompt and tool list.
// Empty prompt = use default. Nil tools = use default.
func (b *ApiBackend) SetPlanModePromptHook(fn func(string) (string, []string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onPlanModePrompt = fn
}

// SetCompactionHooks wires compaction lifecycle callbacks.
func (b *ApiBackend) SetCompactionHooks(before func(string) bool, after func(string, interface{})) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onSessionBeforeCompact = before
	b.onSessionCompact = after
}

// SetPermissionHooks wires permission event callbacks.
func (b *ApiBackend) SetPermissionHooks(onReq func(string, interface{}), onDeny func(string, interface{})) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onPermissionRequest = onReq
	b.onPermissionDenied = onDeny
}

// SetFileChangedHook wires file change callback.
func (b *ApiBackend) SetFileChangedHook(fn func(string, string, string)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.onFileChanged = fn
}

// StartRun begins an agent loop in a background goroutine.
func (b *ApiBackend) StartRun(requestID string, options types.RunOptions) {
	ctx, cancel := context.WithCancel(context.Background())

	run := &activeRun{
		requestID:    requestID,
		cancel:       cancel,
		startTime:    time.Now(),
		steerCh:      make(chan string, 4),
		planMode:     options.PlanMode,
		planFilePath: options.PlanFilePath,
	}

	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	go b.runLoop(ctx, run, options)
}

// Cancel stops a running agent loop. Returns true if a run was found and cancelled.
func (b *ApiBackend) Cancel(requestID string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()

	if !ok {
		return false
	}
	run.cancel()
	return true
}

// GetContextUsage returns the context usage for an active run, or nil if not found.
func (b *ApiBackend) GetContextUsage(requestID string) *conversation.ContextUsageInfo {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok || run.conv == nil {
		return nil
	}
	model := run.conv.Model
	contextWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil {
		contextWindow = info.ContextWindow
	}
	usage := conversation.GetContextUsage(run.conv, contextWindow)
	return &usage
}

// Steer sends a steering message to an active run's conversation.
func (b *ApiBackend) Steer(requestID, message string) bool {
	b.mu.Lock()
	run, ok := b.activeRuns[requestID]
	b.mu.Unlock()
	if !ok {
		return false
	}
	select {
	case run.steerCh <- message:
		return true
	default:
		return false // channel full
	}
}

// WriteToStdin is a no-op for ApiBackend. The API backend uses conversation
// injection (Steer) rather than stdin pipes.
func (b *ApiBackend) WriteToStdin(_ string, _ interface{}) error {
	return nil
}

// IsRunning reports whether a run is currently active.
func (b *ApiBackend) IsRunning(requestID string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	_, ok := b.activeRuns[requestID]
	return ok
}

func (b *ApiBackend) removeRun(requestID string) {
	b.mu.Lock()
	delete(b.activeRuns, requestID)
	b.mu.Unlock()
}

// SetSecurityConfig attaches security configuration for opt-in features.
func (b *ApiBackend) SetSecurityConfig(cfg *types.SecurityConfig) {
	b.securityCfg = cfg
}

func (b *ApiBackend) emit(runID string, event types.NormalizedEvent) {
	// Redact secrets from tool results only when enabled by harness engineer
	if b.securityCfg != nil && b.securityCfg.RedactSecrets {
		if tr, ok := event.Data.(*types.ToolResultEvent); ok {
			tr.Content = insights.RedactSecrets(tr.Content)
			tr.Content = insights.MaskSensitiveFields(tr.Content)
		}
	}
	b.mu.Lock()
	fn := b.onNormalized
	b.mu.Unlock()
	if fn != nil {
		fn(runID, event)
	}
}

func (b *ApiBackend) emitExit(runID string, code *int, signal *string, sessionID string) {
	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.Info("ApiBackend", fmt.Sprintf("emitExit: runID=%s code=%s signal=%s sessionID=%s", runID, codeStr, sigStr, sessionID))
	b.mu.Lock()
	fn := b.onExit
	b.mu.Unlock()
	if fn != nil {
		fn(runID, code, signal, sessionID)
	}
}

func (b *ApiBackend) emitError(runID string, err error) {
	utils.Error("ApiBackend", fmt.Sprintf("emitError: runID=%s err=%s", runID, err.Error()))
	b.mu.Lock()
	fn := b.onError
	b.mu.Unlock()
	if fn != nil {
		fn(runID, err)
	}
}

// contextPercent computes the compaction threshold.
const compactThreshold = 80

// runLoop is the core agent loop. It calls the provider, processes the
// response, executes tools, and loops until the model signals end_turn,
// the budget is exceeded, or the context is cancelled.
func (b *ApiBackend) runLoop(ctx context.Context, run *activeRun, opts types.RunOptions) {
	defer b.removeRun(run.requestID)

	// Resolve provider
	model := opts.Model
	if model == "" {
		model = "claude-sonnet-4-6"
	}

	// Resolve API key via auth resolver and inject into environment
	b.mu.Lock()
	authRes := b.authResolver
	b.mu.Unlock()
	if authRes != nil {
		providerName := providers.ProviderNameForModel(model)
		if providerName != "" {
			if key, err := authRes.ResolveKey(providerName); err == nil && key != "" {
				providers.SetProviderKey(providerName, key)
			}
		}
	}

	provider := providers.ResolveProvider(model)
	if provider == nil {
		utils.Error("ApiBackend", fmt.Sprintf("no provider for model %q", model))
		b.emitError(run.requestID, fmt.Errorf("no provider found for model %q", model))
		b.emitExit(run.requestID, intPtr(1), nil, opts.SessionID)
		return
	}

	// Load or create conversation
	var conv *conversation.Conversation
	if opts.SessionID != "" {
		loaded, err := conversation.Load(opts.SessionID, "")
		if err != nil {
			utils.Log("ApiBackend", "creating new conversation: "+opts.SessionID)
			conv = conversation.CreateConversation(opts.SessionID, opts.SystemPrompt, model)
		} else {
			// Sanitize loaded messages (fix orphaned tool_result blocks, remove thinking)
			loaded.Messages = conversation.SanitizeMessages(loaded.Messages)
			conv = loaded
		}
	} else {
		conv = conversation.CreateConversation(
			fmt.Sprintf("run-%d", time.Now().UnixMilli()),
			opts.SystemPrompt,
			model,
		)
	}
	run.conv = conv

	// Build system prompt
	systemPrompt := conv.System
	if opts.SystemPrompt != "" {
		systemPrompt = opts.SystemPrompt
	}
	if opts.AppendSystemPrompt != "" {
		systemPrompt += "\n\n" + opts.AppendSystemPrompt
	}
	if opts.PlanMode {
		// Check extension hook for custom plan mode prompt
		planPrompt := opts.PlanModePrompt
		if planPrompt == "" {
			b.mu.Lock()
			hookFn := b.onPlanModePrompt
			b.mu.Unlock()
			if hookFn != nil {
				customPrompt, customTools := hookFn(opts.PlanFilePath)
				if customPrompt != "" {
					planPrompt = customPrompt
				}
				if customTools != nil {
					opts.PlanModeTools = customTools
				}
			}
		}
		if planPrompt == "" {
			// Use default plan mode prompt
			_, err := os.Stat(opts.PlanFilePath)
			planPrompt = buildPlanModePrompt(opts.PlanFilePath, err == nil)
		}
		systemPrompt += "\n\n" + planPrompt
	}
	conv.System = systemPrompt

	// Add user message
	conversation.AddUserMessage(conv, opts.Prompt)

	// Resolve max turns
	maxTurns := opts.MaxTurns
	if maxTurns <= 0 {
		maxTurns = 50
	}

	maxBudget := opts.MaxBudgetUsd

	// Fire before_prompt hook
	b.mu.Lock()
	beforePromptFn := b.onBeforePrompt
	b.mu.Unlock()
	if beforePromptFn != nil {
		rewrittenPrompt, extraSystem := beforePromptFn(run.requestID, opts.Prompt)
		if rewrittenPrompt != "" {
			opts.Prompt = rewrittenPrompt
		}
		if extraSystem != "" {
			opts.AppendSystemPrompt += "\n\n" + extraSystem
		}
	}

	// Build tool definitions (built-in + external/MCP + capabilities)
	toolDefs := tools.GetToolDefs()
	b.mu.Lock()
	if len(b.externalTools) > 0 {
		toolDefs = append(toolDefs, b.externalTools...)
	}
	b.mu.Unlock()
	if len(opts.CapabilityTools) > 0 {
		toolDefs = append(toolDefs, opts.CapabilityTools...)
	}
	if opts.CapabilityPrompt != "" {
		systemPrompt += "\n" + opts.CapabilityPrompt
	}

	// Filter tools if plan mode and inject ExitPlanMode
	if opts.PlanMode {
		planTools := opts.PlanModeTools
		if len(planTools) == 0 {
			planTools = defaultPlanModeTools
		}
		allowed := make(map[string]bool, len(planTools)+2)
		for _, t := range planTools {
			allowed[t] = true
		}
		// Always allow Write/Edit so the LLM can write to the plan file
		// (plan-file-only gate in executeTools enforces the target restriction)
		allowed["Write"] = true
		allowed["Edit"] = true
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered

		// Always inject ExitPlanMode sentinel when in plan mode
		exitPlanDef := tools.ExitPlanModeTool()
		toolDefs = append(toolDefs, types.LlmToolDef{
			Name:        exitPlanDef.Name,
			Description: exitPlanDef.Description,
			InputSchema: exitPlanDef.InputSchema,
		})

		// Signal to the desktop that plan mode is now active for this run.
		b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true}})
	}

	// Filter by allowedTools if specified (empty list = no tools, nil = all tools)
	if opts.AllowedTools != nil {
		allowed := make(map[string]bool, len(opts.AllowedTools))
		for _, t := range opts.AllowedTools {
			allowed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if allowed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// When provider supports server-side web search, swap client WebSearch for server tool
	var serverTools []map[string]any
	providerID := provider.ID()
	if providerID == "anthropic" || providerID == "vertex" {
		filtered := toolDefs[:0]
		for _, td := range toolDefs {
			if td.Name != "WebSearch" {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
		serverTools = []map[string]any{{
			"type":     "web_search_20250305",
			"name":     "web_search",
			"max_uses": 5,
		}}
	}

	// Resolve context window for compaction checks
	contextWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(model); info != nil {
		contextWindow = info.ContextWindow
	}

	// Agent loop: turnCount increments at the top of each iteration (before
	// turn_start fires), so the first turn has turnCount=1. This matches the
	// TS reference where turnCount increments at the top of the while loop.
	for run.turnCount < maxTurns {
		if ctx.Err() != nil {
			utils.Warn("ApiBackend", fmt.Sprintf("run cancelled: runID=%s turns=%d cost=$%.4f", run.requestID, run.turnCount, run.totalCost))
			b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
			return
		}

		// Check for steer messages
		select {
		case steerMsg := <-run.steerCh:
			conversation.AddUserMessage(run.conv, steerMsg)
			utils.Log("ApiBackend", "steer message injected into conversation")
		default:
			// no steer message, continue normally
		}

		// Increment turn counter before firing turn_start, so the first turn
		// reports turnCount=1 (matching TS behavior).
		run.turnCount++

		// Fire turn_start hook
		b.mu.Lock()
		turnStartFn := b.onTurnStart
		b.mu.Unlock()
		if turnStartFn != nil {
			turnStartFn(run.requestID, run.turnCount)
		}

		// Check budget
		if maxBudget > 0 && run.totalCost >= maxBudget {
			utils.Warn("ApiBackend", fmt.Sprintf("budget exceeded: runID=%s cost=$%.4f budget=$%.4f", run.requestID, run.totalCost, maxBudget))
			b.emit(run.requestID, types.NormalizedEvent{Data: &types.ErrorEvent{
				ErrorMessage: fmt.Sprintf("budget exceeded: $%.4f >= $%.4f", run.totalCost, maxBudget),
				IsError:      true,
			}})
			break
		}

		// Context compaction cascade at threshold (config override via opts.CompactThreshold)
		threshold := compactThreshold
		if opts.CompactThreshold > 0 {
			threshold = int(opts.CompactThreshold)
		}
		usage := conversation.GetContextUsage(conv, contextWindow)
		if usage.Percent > threshold {
			// Fire session_before_compact hook (can cancel)
			b.mu.Lock()
			beforeCompactFn := b.onSessionBeforeCompact
			afterCompactFn := b.onSessionCompact
			b.mu.Unlock()

			cancelCompact := false
			if beforeCompactFn != nil {
				cancelCompact = beforeCompactFn(run.requestID)
			}

			if !cancelCompact {
				msgBefore := len(conv.Messages)
				cleared := conversation.MicroCompact(conv, 10)
				if cleared == 0 {
					// Try fact extraction; only hard-truncate if still above threshold
					facts := compaction.ExtractFacts(conv.Messages)
					usageAfterFacts := conversation.GetContextUsage(conv, contextWindow)
					if usageAfterFacts.Percent > threshold {
						conversation.Compact(conv, 10)
					}
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
				}
				utils.Log("ApiBackend", fmt.Sprintf("compacted context: was %d%%, cleared %d results", usage.Percent, cleared))

				if afterCompactFn != nil {
					afterCompactFn(run.requestID, map[string]interface{}{
						"strategy":       "auto",
						"messagesBefore": msgBefore,
						"messagesAfter":  len(conv.Messages),
					})
				}
			}
		}

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
		retryConfig := &providers.RetryConfig{
			MaxRetries:    opts.MaxRetries,
			FallbackModel: opts.FallbackModel,
			Persistent:    opts.Persistent,
		}

		b.mu.Lock()
		telem := b.telemetry
		b.mu.Unlock()
		var llmSpan Span
		if telem != nil {
			llmSpan = telem.StartSpan("llm.call", map[string]interface{}{
				"model": model,
				"turn":  run.turnCount,
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
				utils.Warn("ApiBackend", fmt.Sprintf("stream cancelled: runID=%s turn=%d", run.requestID, run.turnCount))
				b.emitExit(run.requestID, intPtr(0), strPtr("cancelled"), conv.ID)
				return
			}
			// G33: prompt_too_long / overloaded -- 3-step cascade then retry
			errMsg := streamErr.Error()
			if (strings.Contains(errMsg, "prompt_too_long") || strings.Contains(errMsg, "prompt is too long") ||
				strings.Contains(errMsg, "overloaded_error")) && run.turnCount > 0 {
				utils.Log("ApiBackend", "prompt too long, running compaction cascade and retrying")

				// Step 1: micro-compact (drop metadata, trim tool results)
				cleared := conversation.MicroCompact(conv, 10)
				utils.Log("ApiBackend", fmt.Sprintf("prompt_too_long micro-compact cleared %d results", cleared))

				// Step 2: LLM summary compaction via fact extraction
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

				// Step 3: hard truncate if still needed
				usageAfterExtract := conversation.GetContextUsage(conv, contextWindow)
				threshold := compactThreshold
				if opts.CompactThreshold > 0 {
					threshold = int(opts.CompactThreshold)
				}
				if usageAfterExtract.Percent > threshold {
					utils.Log("ApiBackend", "still above threshold after fact extraction, hard truncating")
					conversation.Compact(conv, 10)
				}

				continue // retry the turn after compaction
			}
			utils.Error("ApiBackend", fmt.Sprintf("stream error: runID=%s turn=%d err=%s", run.requestID, run.turnCount, streamErr.Error()))
			b.emitError(run.requestID, streamErr)
			b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
			return
		}

		// Stream truncated (no stop reason) -- emit reset so desktop discards
		// partial text, then retry the turn.
		if stopReason == "" {
			utils.Warn("ApiBackend", fmt.Sprintf("stream truncated (no stop reason): runID=%s turn=%d, retrying", run.requestID, run.turnCount))
			b.emit(run.requestID, types.NormalizedEvent{Data: &types.StreamResetEvent{}})
			continue
		}

		// Track usage and cost
		if turnUsage != nil {
			costUsd := computeCost(model, *turnUsage)
			run.totalCost += costUsd
			conversation.UpdateCost(conv, costUsd)

			// Emit usage event with input tokens so desktop shows context percentage
			inTok := turnUsage.InputTokens
			outTok := turnUsage.OutputTokens
			b.emit(run.requestID, types.NormalizedEvent{Data: &types.UsageEvent{
				Usage: types.UsageData{
					InputTokens:  &inTok,
					OutputTokens: &outTok,
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
		}

		// Fire turn_end hook
		b.mu.Lock()
		turnEndFn := b.onTurnEnd
		b.mu.Unlock()
		if turnEndFn != nil {
			turnEndFn(run.requestID, run.turnCount)
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
			utils.Info("ApiBackend", fmt.Sprintf("run complete: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, run.turnCount, run.totalCost, elapsed, conv.ID))
			b.emit(run.requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
				Result:     resultText,
				CostUsd:    run.totalCost,
				DurationMs: elapsed,
				NumTurns:   run.turnCount,
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
				b.emitError(run.requestID, err)
				b.emitExit(run.requestID, intPtr(1), nil, conv.ID)
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
				utils.Info("ApiBackend", fmt.Sprintf("plan mode exited: runID=%s turns=%d cost=$%.4f elapsed=%dms sessionID=%s", run.requestID, run.turnCount, run.totalCost, elapsed, conv.ID))
				b.emit(run.requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
					Result:            "Plan mode exited.",
					CostUsd:           run.totalCost,
					DurationMs:        elapsed,
					NumTurns:          run.turnCount,
					SessionID:         conv.ID,
					PermissionDenials: denials,
				}})
				b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
				return
			}

			// Add tool results to conversation
			conversation.AddToolResults(conv, results)

		case "max_tokens":
			utils.Info("ApiBackend", fmt.Sprintf("max_tokens reached, continuing: runID=%s turn=%d", run.requestID, run.turnCount))
			// Add continue message and loop
			conversation.AddUserMessage(conv, "Continue from where you left off.")

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
	b.emit(run.requestID, types.NormalizedEvent{Data: &types.TaskCompleteEvent{
		Result:     fmt.Sprintf("Reached max turns (%d)", maxTurns),
		CostUsd:    run.totalCost,
		DurationMs: elapsed,
		NumTurns:   run.turnCount,
		SessionID:  conv.ID,
	}})
	utils.Warn("ApiBackend", fmt.Sprintf("max turns exceeded: runID=%s turns=%d/%d cost=$%.4f", run.requestID, run.turnCount, maxTurns, run.totalCost))
	b.emitExit(run.requestID, intPtr(0), nil, conv.ID)
}

// processStream consumes LLM stream events, emits normalized events, and
// returns the collected assistant content blocks, stop reason, and usage.
func (b *ApiBackend) processStream(
	ctx context.Context,
	run *activeRun,
	events <-chan types.LlmStreamEvent,
	errc <-chan error,
) ([]types.LlmContentBlock, string, *types.LlmUsage, error) {

	var assistantBlocks []types.LlmContentBlock
	var currentBlockIndex int
	var currentPartialJSON strings.Builder
	var stopReason string
	var cumUsage types.LlmUsage
	var toolCallIndex int

	for ev := range events {
		if ctx.Err() != nil {
			return nil, "", nil, ctx.Err()
		}

		switch ev.Type {
		case "message_start":
			if ev.MessageInfo != nil {
				cumUsage = ev.MessageInfo.Usage
				// Emit cache token counts so clients see them immediately
				// (TS emits cache_read from message_start).
				if cumUsage.CacheReadInputTokens > 0 || cumUsage.CacheCreationInputTokens > 0 {
					cri := cumUsage.CacheReadInputTokens
					cci := cumUsage.CacheCreationInputTokens
					b.emit(run.requestID, types.NormalizedEvent{Data: &types.UsageEvent{
						Usage: types.UsageData{
							CacheReadInputTokens:     &cri,
							CacheCreationInputTokens: &cci,
						},
					}})
				}
			}

		case "content_block_start":
			if ev.ContentBlock == nil {
				continue
			}
			cb := ev.ContentBlock
			block := types.LlmContentBlock{
				Type:      cb.Type,
				ID:        cb.ID,
				Name:      cb.Name,
				Text:      cb.Text,
				ToolUseID: cb.ToolUseID,
			}
			// web_search_tool_result: serialize search results into Content string
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if raw, err := json.Marshal(cb.Content); err == nil {
					block.Content = string(raw)
				}
			}
			currentBlockIndex = ev.BlockIndex
			assistantBlocks = appendOrGrow(assistantBlocks, currentBlockIndex, block)

			if cb.Type == "tool_use" {
				b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolCallEvent{
					ToolName: cb.Name,
					ToolID:   cb.ID,
					Index:    toolCallIndex,
				}})
				toolCallIndex++
				currentPartialJSON.Reset()
			}

			// Server-side tool use (e.g. web_search) -- accumulate input JSON but don't execute locally
			if cb.Type == "server_tool_use" {
				currentPartialJSON.Reset()
			}

			// Server-side search results -- emit event for desktop rendering
			if cb.Type == "web_search_tool_result" && cb.Content != nil {
				if results, ok := cb.Content.([]any); ok {
					var hits []types.WebSearchHit
					for _, r := range results {
						if m, ok := r.(map[string]any); ok {
							hit := types.WebSearchHit{}
							if t, ok := m["title"].(string); ok {
								hit.Title = t
							}
							if u, ok := m["url"].(string); ok {
								hit.URL = u
							}
							if hit.URL != "" {
								hits = append(hits, hit)
							}
						}
					}
					if len(hits) > 0 {
						b.emit(run.requestID, types.NormalizedEvent{Data: &types.WebSearchResultEvent{
							Results: hits,
						}})
					}
				}
			}

		case "content_block_delta":
			if ev.Delta == nil {
				continue
			}
			delta := ev.Delta

			if delta.Type == "text_delta" && delta.Text != "" {
				if currentBlockIndex < len(assistantBlocks) {
					assistantBlocks[currentBlockIndex].Text += delta.Text
				}
				b.emit(run.requestID, types.NormalizedEvent{Data: &types.TextChunkEvent{
					Text: delta.Text,
				}})
			}

			if delta.Type == "input_json_delta" && delta.PartialJSON != "" {
				currentPartialJSON.WriteString(delta.PartialJSON)
				if currentBlockIndex < len(assistantBlocks) {
					toolID := assistantBlocks[currentBlockIndex].ID
					b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolCallUpdateEvent{
						ToolID:       toolID,
						PartialInput: delta.PartialJSON,
					}})
				}
			}

		case "content_block_stop":
			// Parse accumulated tool input JSON (client or server tool)
			if currentBlockIndex < len(assistantBlocks) {
				block := &assistantBlocks[currentBlockIndex]
				if (block.Type == "tool_use" || block.Type == "server_tool_use") && currentPartialJSON.Len() > 0 {
					var input map[string]any
					if err := json.Unmarshal([]byte(currentPartialJSON.String()), &input); err == nil {
						block.Input = input
					}
					currentPartialJSON.Reset()
				}
			}

			b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolCallCompleteEvent{
				Index: currentBlockIndex,
			}})

		case "message_delta":
			if ev.Delta != nil && ev.Delta.StopReason != nil {
				stopReason = *ev.Delta.StopReason
			}
			if ev.DeltaUsage != nil {
				// Accumulate final usage
				cumUsage.OutputTokens += ev.DeltaUsage.OutputTokens
			}
		}
	}

	// Check for stream error
	var streamErr error
	if errc != nil {
		streamErr = <-errc
	}

	return assistantBlocks, stopReason, &cumUsage, streamErr
}

// executeTools runs tool calls in parallel using errgroup.
func (b *ApiBackend) executeTools(
	ctx context.Context,
	run *activeRun,
	toolUseBlocks []types.LlmContentBlock,
	cwd string,
) ([]conversation.ToolResultEntry, error) {

	results := make([]conversation.ToolResultEntry, len(toolUseBlocks))
	g, gCtx := errgroup.WithContext(ctx)

	// Snapshot hook/config references once for all goroutines
	b.mu.Lock()
	hookFn := b.onToolCall
	perToolHook := b.onPerToolHook
	permEng := b.permEngine
	sbCfg := b.sandboxCfg
	mcpRouter := b.mcpToolRouter
	fileChangedFn := b.onFileChanged
	permReqFn := b.onPermissionRequest
	permDenyFn := b.onPermissionDenied
	telem := b.telemetry
	b.mu.Unlock()

	for i, block := range toolUseBlocks {
		i, block := i, block
		g.Go(func() error {
			// Permission check (Step 3)
			if permEng != nil {
				checkResult := permEng.Check(permissions.CheckInfo{
					Tool:  block.Name,
					Input: block.Input,
					Cwd:   cwd,
				})
				if permReqFn != nil {
					permReqFn(run.requestID, map[string]interface{}{
						"tool_name": block.Name,
						"input":     block.Input,
						"decision":  checkResult.Decision,
					})
				}
				if checkResult.Decision == "deny" {
					if permDenyFn != nil {
						permDenyFn(run.requestID, map[string]interface{}{
							"tool_name": block.Name,
							"input":     block.Input,
							"reason":    checkResult.Reason,
						})
					}
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Permission denied: " + checkResult.Reason,
						IsError:   true,
					}
					b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: results[i].Content,
						IsError: true,
					}})
					return nil
				}
			}

			// Sandbox validation for Bash tool (Step 3)
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					safe, reason := sandbox.ValidateWithConfig(cmd, *sbCfg)
					if !safe {
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   "Sandbox blocked: " + reason,
							IsError:   true,
						}
						b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: results[i].Content,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// After sandbox validation passes, wrap if sandbox config exists
			if (block.Name == "Bash" || block.Name == "bash") && sbCfg != nil {
				if cmd, ok := block.Input["command"].(string); ok {
					if wrapped, err := sandbox.WrapCommand(cmd, *sbCfg, ""); err == nil && wrapped != cmd {
						block.Input["command"] = wrapped
					}
				}
			}

			// Call onToolCall hook (extension hook)
			if hookFn != nil {
				result, err := hookFn(ToolCallInfo{
					ToolName: block.Name,
					ToolID:   block.ID,
					Input:    block.Input,
				})
				if err != nil {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Hook error: " + err.Error(),
						IsError:   true,
					}
					return nil
				}
				if result != nil && result.Block {
					results[i] = conversation.ToolResultEntry{
						ToolUseID: block.ID,
						Content:   "Blocked: " + result.Reason,
						IsError:   true,
					}
					b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
						ToolID:  block.ID,
						Content: "Blocked: " + result.Reason,
						IsError: true,
					}})
					return nil
				}
			}

			// Pre-tool hook
			if perToolHook != nil {
				_, _ = perToolHook(block.Name, block.Input, "before")
			}

			// Telemetry span for tool execution
			var toolSpan Span
			if telem != nil {
				toolSpan = telem.StartSpan("tool.execute", map[string]interface{}{
					"tool": block.Name,
				})
			}

			// Plan mode write gate: only the plan file is writable.
			if run.planMode && (block.Name == "Write" || block.Name == "Edit") {
				if targetPath, ok := block.Input["file_path"].(string); ok {
					if targetPath != run.planFilePath {
						msg := fmt.Sprintf("Plan mode: cannot write to %s. Only the plan file (%s) is writable.", targetPath, run.planFilePath)
						results[i] = conversation.ToolResultEntry{
							ToolUseID: block.ID,
							Content:   msg,
							IsError:   true,
						}
						b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
							ToolID:  block.ID,
							Content: msg,
							IsError: true,
						}})
						return nil
					}
				}
			}

			// Intercept ExitPlanMode sentinel — never dispatch to executor.
			if block.Name == tools.ExitPlanModeName {
				run.mu.Lock()
				run.exitPlanMode = true
				run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
					ToolName:  block.Name,
					ToolUseID: block.ID,
					ToolInput: map[string]any{"planFilePath": run.planFilePath},
				})
				run.mu.Unlock()
				// Signal to the desktop that plan mode is now exiting.
				b.emit(run.requestID, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: false, PlanFilePath: run.planFilePath}})
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Plan mode exited.",
					IsError:   false,
				}
				b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
					ToolID:  block.ID,
					Content: "Plan mode exited.",
					IsError: false,
				}})
				return nil
			}

			// Route to MCP or built-in tool (Step 5)
			var toolResult *types.ToolResult
			var err error

			if strings.HasPrefix(block.Name, "mcp__") && mcpRouter != nil {
				content, isErr, routeErr := mcpRouter(block.Name, block.Input)
				if routeErr != nil {
					err = routeErr
				} else {
					toolResult = &types.ToolResult{Content: content, IsError: isErr}
				}
			} else {
				toolResult, err = tools.ExecuteTool(gCtx, block.Name, block.Input, cwd)
			}

			// End tool span
			if toolSpan != nil {
				errStr := ""
				if err != nil {
					errStr = err.Error()
				}
				toolSpan.End(nil, errStr)
			}

			if err != nil {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   "Error: " + err.Error(),
					IsError:   true,
				}
			} else {
				results[i] = conversation.ToolResultEntry{
					ToolUseID: block.ID,
					Content:   toolResult.Content,
					IsError:   toolResult.IsError,
				}
			}

			// Fire file_changed hook for write/edit tools
			if fileChangedFn != nil && !results[i].IsError {
				switch block.Name {
				case "Write", "write":
					if p, ok := block.Input["file_path"].(string); ok {
						fileChangedFn(run.requestID, p, "write")
					}
				case "Edit", "edit":
					if p, ok := block.Input["file_path"].(string); ok {
						fileChangedFn(run.requestID, p, "edit")
					}
				}
			}

			// Post-tool hook
			if perToolHook != nil {
				_, _ = perToolHook(block.Name, results[i], "after")
			}

			// Emit tool_result event
			b.emit(run.requestID, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: results[i].Content,
				IsError: results[i].IsError,
			}})

			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}

// computeCost estimates the USD cost for a turn using the model registry.
func computeCost(model string, usage types.LlmUsage) float64 {
	info := providers.GetModelInfo(model)
	if info == nil {
		return 0
	}
	inputCost := float64(usage.InputTokens) / 1000.0 * info.CostPer1kInput
	outputCost := float64(usage.OutputTokens) / 1000.0 * info.CostPer1kOutput
	return inputCost + outputCost
}

// appendOrGrow ensures the slice is large enough for the given index.
func appendOrGrow(blocks []types.LlmContentBlock, idx int, block types.LlmContentBlock) []types.LlmContentBlock {
	for len(blocks) <= idx {
		blocks = append(blocks, types.LlmContentBlock{})
	}
	blocks[idx] = block
	return blocks
}

func intPtr(v int) *int       { return &v }
func strPtr(v string) *string { return &v }
