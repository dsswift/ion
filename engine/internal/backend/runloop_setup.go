package backend

import (
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolveProvider resolves the provider for the given model and injects the
// provider's API key (if available) into the global provider key registry.
// Returns nil if no provider supports the model.
func (b *ApiBackend) resolveProvider(model string) providers.LlmProvider {
	b.mu.Lock()
	authRes := b.authResolver
	b.mu.Unlock()
	providerName := providers.ProviderNameForModel(model)
	if authRes != nil && providerName != "" {
		if key, err := authRes.ResolveKey(providerName); err == nil && key != "" {
			providers.SetProviderKey(providerName, key)
			utils.Log("ApiBackend", fmt.Sprintf("resolved key for provider=%s (len=%d)", providerName, len(key)))
		} else if err != nil {
			utils.Log("ApiBackend", fmt.Sprintf("no key for provider=%s: %v", providerName, err))
		}
	}
	p := providers.ResolveProvider(model)
	if p != nil {
		// Also check what key the provider will actually use at request time
		runtimeKey := providers.GetProviderKey(p.ID())
		utils.Log("ApiBackend", fmt.Sprintf("resolved model=%s → provider=%s (nameForModel=%s, runtimeKeyLen=%d)", model, p.ID(), providerName, len(runtimeKey)))
	} else {
		utils.Log("ApiBackend", fmt.Sprintf("resolved model=%s → nil (nameForModel=%s)", model, providerName))
	}
	return p
}

// loadOrCreateConversation returns an existing conversation when SessionID
// resolves to one on disk, otherwise creates a new conversation with a
// timestamp+random suffix id that cannot collide with same-millisecond peers.
func loadOrCreateConversation(opts types.RunOptions, model string) *conversation.Conversation {
	if opts.SessionID != "" {
		loaded, err := conversation.Load(opts.SessionID, "")
		if err != nil {
			utils.Log("ApiBackend", "creating new conversation: "+opts.SessionID)
			return conversation.CreateConversation(opts.SessionID, opts.SystemPrompt, model)
		}
		// Sanitize loaded messages (fix orphaned tool_result blocks, remove thinking)
		loaded.Messages = conversation.SanitizeMessages(loaded.Messages)
		return loaded
	}
	// Append a 6-byte random suffix so two runs that begin in the same
	// millisecond cannot collide on the conversation file. Falls back to
	// a counter on the (extremely unlikely) rand.Read failure.
	return conversation.CreateConversation(
		fmt.Sprintf("%d-%s", time.Now().UnixMilli(), newConvSuffix()),
		opts.SystemPrompt,
		model,
	)
}

// buildSystemPrompt assembles the final system prompt for a run, layering in
// plan-mode prompt, before_prompt hook contributions, and the capability
// prompt. May rewrite opts.Prompt and opts.PlanModeTools as a side effect when
// a hook returns a non-empty replacement. When run is non-nil and the
// plan_mode_prompt hook returns a SparseReminder, the override is cached on
// run.planModeSparseReminderOverride for use by per-turn reminder injections
// (the RunOptions.PlanModeSparseReminder field takes precedence over the hook
// at injection time — see runloop.go).
func buildSystemPrompt(opts *types.RunOptions, conv *conversation.Conversation, hooks RunHooks, requestID string, run *activeRun) string {
	systemPrompt := conv.System
	if opts.SystemPrompt != "" {
		systemPrompt = opts.SystemPrompt
	}
	if opts.AppendSystemPrompt != "" {
		// When AppendSystemPrompt is set, always rebuild from the explicit
		// SystemPrompt base (or empty string). This prevents duplication
		// when conv.System already contains content from a previous run.
		base := opts.SystemPrompt // explicit override, or ""
		systemPrompt = base + "\n\n" + opts.AppendSystemPrompt
	}
	if opts.PlanMode {
		// Check extension hook for custom plan mode prompt
		planPrompt := opts.PlanModePrompt
		if planPrompt == "" && hooks.OnPlanModePrompt != nil {
			customPrompt, customTools, customSparseReminder := hooks.OnPlanModePrompt(opts.PlanFilePath)
			if customPrompt != "" {
				planPrompt = customPrompt
			}
			if customTools != nil {
				opts.PlanModeTools = customTools
			}
			// Cache the hook's sparse-reminder override on the run so per-turn
			// reminder injections in runloop.go can reuse it without re-firing
			// the hook. RunOptions.PlanModeSparseReminder takes precedence (see
			// runloop.go reminder resolution block), so we only cache the hook
			// result here; the resolution priority check happens at injection time.
			if customSparseReminder != "" && run != nil && run.planModeSparseReminderOverride == "" {
				run.planModeSparseReminderOverride = customSparseReminder
				utils.Info("PlanMode", fmt.Sprintf("run=%s sparse_reminder_override=hook len=%d", requestID, len(customSparseReminder)))
			}
		}
		if planPrompt == "" {
			// Use default plan mode prompt
			_, err := os.Stat(opts.PlanFilePath)
			planPrompt = buildPlanModePrompt(opts.PlanFilePath, err == nil)
		}
		// Prepend reentry guidance when returning to plan mode after a
		// previous exit. This tells the LLM to read the existing plan and
		// decide whether to amend, replace, or extend it.
		if opts.PlanModeReentry {
			planPrompt = buildPlanModeReentryPrompt(opts.PlanFilePath) + "\n\n" + planPrompt
		}
		systemPrompt += "\n\n" + planPrompt
	}
	// Fire before_prompt hook (before finalizing system prompt)
	if hooks.OnBeforePrompt != nil {
		rewrittenPrompt, extraSystem := hooks.OnBeforePrompt(requestID, opts.Prompt)
		if rewrittenPrompt != "" {
			opts.Prompt = rewrittenPrompt
		}
		if extraSystem != "" {
			systemPrompt += "\n\n" + extraSystem
		}
	}

	// Add capability prompt
	if opts.CapabilityPrompt != "" {
		systemPrompt += "\n" + opts.CapabilityPrompt
	}
	return systemPrompt
}

// buildToolDefs assembles the active tool list for a run: built-in tools plus
// external/MCP tools plus capability tools, then applies plan-mode filtering,
// allowed/suppressed filters, and provider-side WebSearch swap. Returns the
// final tool definitions and any provider server-side tool descriptors.
func (b *ApiBackend) buildToolDefs(run *activeRun, opts types.RunOptions, provider providers.LlmProvider) ([]types.LlmToolDef, []map[string]any) {
	toolDefs := tools.GetToolDefs()
	var externalTools []types.LlmToolDef
	if run.cfg != nil {
		externalTools = run.cfg.ExternalTools
	}
	extToolCount := len(externalTools)
	if extToolCount > 0 {
		toolDefs = append(toolDefs, externalTools...)
	}
	utils.Log("ApiBackend", fmt.Sprintf("tool count: builtin=%d external=%d total=%d", len(toolDefs)-extToolCount, extToolCount, len(toolDefs)))
	if len(opts.CapabilityTools) > 0 {
		toolDefs = append(toolDefs, opts.CapabilityTools...)
	}

	// Always inject AskUserQuestion so the LLM can pause the run to ask a
	// clarifying question in any mode. The engine intercepts calls to this tool
	// unconditionally (see runloop_tools.go), records a PermissionDenial with
	// the question payload, and terminates the run so the client can surface
	// the question and feed the user's answer back as the next prompt.
	askDef := tools.AskUserQuestionTool()
	toolDefs = append(toolDefs, types.LlmToolDef{
		Name:        askDef.Name,
		Description: askDef.Description,
		InputSchema: askDef.InputSchema,
	})

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
		// AskUserQuestion is injected unconditionally above; keep it through
		// the plan-mode filter so it is still available during plan mode.
		allowed[tools.AskUserQuestionName] = true
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

		// Emit a state-transition event so consumers can mirror the active
		// plan-mode flag. Snapshot-style: the event is the authoritative
		// signal that the run is now in plan mode.
		b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true}})
		utils.Info("PlanMode", fmt.Sprintf("run=%s tools_filtered=%d allowed=%v", run.requestID, len(toolDefs), planTools))
	} else {
		// Inject EnterPlanMode sentinel in auto mode so the LLM can request
		// a transition into plan mode when it judges the task warrants planning.
		// Symmetric with ExitPlanMode which is injected only in plan mode.
		//
		// Implementation-phase suppression: when the harness has set
		// RunOptions.ImplementationPhase=true (e.g. a harness button that
		// hands off an approved plan to an "implement" run), the engine
		// skips the injection entirely so the model can't propose a fresh
		// plan-mode entry mid-implementation. This replaces the previous
		// prompt-text substring-matching mechanism with a structured
		// boolean — see the field comment in
		// engine/internal/types/types.go.
		if opts.ImplementationPhase {
			utils.Info("PlanMode", fmt.Sprintf("run=%s skipping EnterPlanMode injection (implementation_phase=true)", run.requestID))
		} else {
			// Resolve the EnterPlanMode tool description: harness-supplied
			// prose wins; empty falls back to the engine's one-line
			// default. Per ADR-004 the policy prose lives in the harness;
			// the engine never composes its own opinionated framing.
			// Log which branch ran so the operational log captures the
			// resolution path (logging policy: log both sides of every
			// decision).
			descSource := "default"
			descLen := 0
			if opts.EnterPlanModeDescription != "" {
				descSource = "harness"
				descLen = len(opts.EnterPlanModeDescription)
			}
			enterPlanDef := tools.EnterPlanModeToolWithDescription(opts.EnterPlanModeDescription)
			toolDefs = append(toolDefs, types.LlmToolDef{
				Name:        enterPlanDef.Name,
				Description: enterPlanDef.Description,
				InputSchema: enterPlanDef.InputSchema,
			})
			utils.Info("PlanMode", fmt.Sprintf("run=%s injected EnterPlanMode in auto mode enter_plan_mode_desc=%s len=%d", run.requestID, descSource, descLen))
		}
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

	// Filter out suppressed tools
	if len(opts.SuppressTools) > 0 {
		suppressed := make(map[string]bool, len(opts.SuppressTools))
		for _, t := range opts.SuppressTools {
			suppressed[t] = true
		}
		var filtered []types.LlmToolDef
		for _, td := range toolDefs {
			if !suppressed[td.Name] {
				filtered = append(filtered, td)
			}
		}
		toolDefs = filtered
	}

	// Web search mode resolution: determine whether to use server-side
	// (Anthropic built-in) or client-side (Brave/Tavily/SearXNG) web search.
	var serverTools []map[string]any
	providerID := provider.ID()
	supportsServer := providerID == "anthropic" || providerID == "vertex"
	mode := opts.WebSearchMode
	if mode == "" {
		mode = "auto"
	}

	useServer := false
	switch mode {
	case "server":
		useServer = supportsServer
	case "client":
		useServer = false
	default: // "auto"
		// Prefer client if a backend key is configured (better reliability:
		// model gets a follow-up turn to process results). Fall back to
		// server on Anthropic/Vertex when no client key is available.
		if supportsServer && !tools.HasSearchBackend() {
			useServer = true
		}
	}

	if useServer {
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

	return toolDefs, serverTools
}
