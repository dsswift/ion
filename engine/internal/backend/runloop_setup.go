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
	if authRes != nil {
		providerName := providers.ProviderNameForModel(model)
		if providerName != "" {
			if key, err := authRes.ResolveKey(providerName); err == nil && key != "" {
				providers.SetProviderKey(providerName, key)
			}
		}
	}
	return providers.ResolveProvider(model)
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
// a hook returns a non-empty replacement.
func buildSystemPrompt(opts *types.RunOptions, conv *conversation.Conversation, hooks RunHooks, requestID string) string {
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
		if planPrompt == "" && hooks.OnPlanModePrompt != nil {
			customPrompt, customTools := hooks.OnPlanModePrompt(opts.PlanFilePath)
			if customPrompt != "" {
				planPrompt = customPrompt
			}
			if customTools != nil {
				opts.PlanModeTools = customTools
			}
		}
		if planPrompt == "" {
			// Use default plan mode prompt
			_, err := os.Stat(opts.PlanFilePath)
			planPrompt = buildPlanModePrompt(opts.PlanFilePath, err == nil)
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
		b.emit(run, types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true}})
		utils.Info("PlanMode", fmt.Sprintf("run=%s tools_filtered=%d allowed=%v", run.requestID, len(toolDefs), planTools))
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

	return toolDefs, serverTools
}
