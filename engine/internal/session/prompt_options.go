package session

import (
	"strings"

	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/gitcontext"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// buildPromptOverrides constructs the *PromptOverrides for a per-prompt
// dispatch from the two run-scoped options every sendPrompt entry point
// carries: an optional model override and optional plan-mode Bash allowlist
// additions. Returns nil when both are empty so callers pass nil (the
// "no overrides" sentinel) rather than an empty struct.
//
// This is the single seam every sendPrompt path routes through so the active-
// hook path (sessionAccessor.SendPrompt) and the fallback path (the
// onSendMessage closures wired in start_session.go and prompt_extensions.go)
// produce identical overrides for identical input. Centralizing it here is the
// "one pipeline" guarantee — there is no way for one entry point to build
// overrides differently from another.
//
// The bash additions are unioned with the session allowlist for this single
// run via opts.BashAllowlistAdditionsForThisPrompt (applied in buildRunOptions
// below) and the run loop's effectiveBashAllowlist; they are never persisted on
// the engineSession. See extension.Context.SendPrompt for the contract.
func buildPromptOverrides(model string, bashAllowlistAdditions []string) *PromptOverrides {
	if model == "" && len(bashAllowlistAdditions) == 0 {
		return nil
	}
	overrides := &PromptOverrides{Model: model}
	if len(bashAllowlistAdditions) > 0 {
		overrides.BashAllowlistAdditionsForThisPrompt = bashAllowlistAdditions
	}
	return overrides
}

// dispatchSendPromptPayload is the single onSendMessage callback body shared by
// every extension-wiring site (start_session.go's loadAndWireExtensions and
// prompt_extensions.go's lateLoadExtensions). Both sites install this exact
// method as the host's onSendMessage callback, so a follow-up prompt queued by
// an extension carries identical run configuration regardless of which wiring
// path created the host. Extracting it here removes the previously-duplicated
// closure bodies — the duplication was itself a "two ways to do one thing"
// hazard that could drift — and creates a directly-testable seam that pins the
// full payload (text + model + bash-allowlist additions) flows through to
// m.SendPrompt and is not dropped.
//
// origin is a short label ("start_session" / "prompt_extensions") used only in
// the log line so an operator can tell which wiring site queued the prompt.
func (m *Manager) dispatchSendPromptPayload(key, origin string, payload extension.SendPromptPayload) {
	overrides := buildPromptOverrides(payload.Model, payload.BashAllowlistAdditions)
	if len(payload.BashAllowlistAdditions) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "onsendmessage(): forwarding bash-allowlist additions", map[string]any{"origin": origin, "key": key, "count": len(payload.BashAllowlistAdditions), "bash_allowlist_additions": payload.BashAllowlistAdditions})
	}
	if err := m.SendPrompt(key, payload.Text, overrides); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "ext/send_message failed", map[string]any{"error": err})
	}
}

func buildRunOptions(s *engineSession, text string, overrides *PromptOverrides) types.RunOptions {
	opts := types.RunOptions{
		Prompt:      text,
		ProjectPath: s.config.WorkingDirectory,
		// ClaudeCompat mirrors the session's Claude-compatibility setting onto
		// the run so the backend's nested context loader gates Claude files
		// (CLAUDE.md) the same way the eager walk does. Ion-native files load
		// regardless of this flag.
		ClaudeCompat: s.config.ClaudeCompat,
		// ConversationID is Ion's conversation-file identity. The API backend
		// uses it to load/create ~/.ion/conversations/<id>.* and to resume.
		ConversationID: s.conversationID,
		// SessionKey is the opaque client-supplied key for this session (the
		// tab UUID for desktop clients). The backend threads it into telemetry
		// so tier-4 events stamp session_id = the session key, consistent with
		// the session-layer correlationCtx emissions.
		SessionKey: s.key,
		// ExtensionName and ExtensionVersion carry the hosting extension's
		// identity into the backend so buildTelemCtx can stamp "extension" and
		// "extension_version" on llm.call and dispatch.agent spans. Both are
		// omit-when-empty so non-extension runs are unaffected.
		ExtensionName:    s.extensionName,
		ExtensionVersion: s.extensionVersion,
		// ParentConversationID is forwarded so a fresh conversation created by
		// this run records its descent from a prior session (client-driven
		// checkpoint cut). Inert when resuming an existing conversation.
		ParentConversationID: s.config.ParentConversationID,
		// CliResumeSessionID is claude's own captured session UUID (empty on
		// the first CLI run → no --resume). The API backend ignores it; only
		// the CLI backend reads it. Distinct identity space from SessionID.
		CliResumeSessionID:          s.cliSessionID,
		MaxTokens:                   s.config.MaxTokens,
		Thinking:                    s.config.Thinking,
		PlanMode:                    s.planMode,
		PlanModeTools:               s.planModeTools,
		PlanFilePath:                s.planFilePath,
		PlanModeAllowedBashCommands: s.planModeAllowedBashCommands,
	}

	if overrides != nil {
		if overrides.Model != "" {
			opts.Model = overrides.Model
		}
		if overrides.MaxTurns > 0 {
			opts.MaxTurns = overrides.MaxTurns
		}
		if overrides.MaxBudgetUsd > 0 {
			opts.MaxBudgetUsd = overrides.MaxBudgetUsd
		}
		if overrides.AppendSystemPrompt != "" {
			opts.AppendSystemPrompt += "\n\n" + overrides.AppendSystemPrompt
		}
		if len(overrides.Attachments) > 0 {
			opts.Attachments = overrides.Attachments
		}
		// Forward the structured implementation-phase flag onto RunOptions
		// so runloop_setup can suppress the EnterPlanMode sentinel-tool
		// injection. The flag is strictly subtractive — if the run is
		// already in plan mode the engine never injects EnterPlanMode
		// regardless, so the flag has no effect there.
		if overrides.ImplementationPhase {
			opts.ImplementationPhase = true
		}
		// Per-prompt thinking effort (live per-conversation control). A
		// non-empty, non-"off" level sets RunOptions.Thinking for this run;
		// "off"/"" explicitly clears it so the prompt carries no thinking
		// directive even if a session default existed. This is the single
		// place the per-prompt effort lands on the run; the provider
		// body-builders resolve the per-model mechanism downstream.
		if eff := overrides.ThinkingEffort; eff != "" && eff != "off" {
			opts.Thinking = &types.ThinkingConfig{Enabled: true, Effort: eff}
		} else if eff == "off" {
			opts.Thinking = nil
		}
		// Forward the harness-supplied EnterPlanMode tool description.
		// Empty string means "fall back to engine default" — runloop_setup
		// resolves the actual prose via tools.EnterPlanModeToolWithDescription.
		// Per ADR-004, the engine does not impose a policy default beyond
		// the one-line neutral fallback.
		if overrides.EnterPlanModeDescription != "" {
			opts.EnterPlanModeDescription = overrides.EnterPlanModeDescription
		}
		// Forward the harness-supplied sparse-reminder override.
		// Empty string means "use buildPlanModeSparseReminder default".
		if overrides.PlanModeSparseReminder != "" {
			opts.PlanModeSparseReminder = overrides.PlanModeSparseReminder
		}
		// Forward the per-prompt bash-allowlist additions. The field is
		// transient by design: opts.BashAllowlistAdditionsForThisPrompt is
		// unioned with the session allowlist when runloop_setup builds the
		// run-time tool list (see buildToolDefs). The session-level
		// engineSession.planModeAllowedBashCommands is NOT mutated by this
		// field — that invariant is the point of having a separate field
		// rather than a session-scoped mutation here.
		if len(overrides.BashAllowlistAdditionsForThisPrompt) > 0 {
			opts.BashAllowlistAdditionsForThisPrompt = overrides.BashAllowlistAdditionsForThisPrompt
		}
		// Compaction overrides — per-prompt tuning of context compaction.
		if overrides.CompactTargetPercent > 0 {
			opts.CompactTargetPercent = overrides.CompactTargetPercent
		}
		if overrides.CompactMicroKeepTurns > 0 {
			opts.CompactMicroKeepTurns = overrides.CompactMicroKeepTurns
		}
		if overrides.CompactEnabled != nil {
			opts.CompactEnabled = overrides.CompactEnabled
		}
		if overrides.CompactSummaryEnabled != nil {
			opts.CompactSummaryEnabled = overrides.CompactSummaryEnabled
		}
		if overrides.CompactMemoryEnabled != nil {
			opts.CompactMemoryEnabled = overrides.CompactMemoryEnabled
		}
	}

	if s.config.SystemHint != "" {
		opts.AppendSystemPrompt += "\n\n" + s.config.SystemHint
	}
	return opts
}

// applyConfigDefaults fills opts fields from manager-level config when
// the session/overrides did not specify them.
func (m *Manager) applyConfigDefaults(opts *types.RunOptions) {
	if m.config == nil {
		return
	}
	if opts.Model == "" {
		opts.Model = m.config.DefaultModel
	}
	if opts.MaxTurns <= 0 && m.config.Limits.MaxTurns != nil {
		opts.MaxTurns = *m.config.Limits.MaxTurns
	}
	if opts.MaxBudgetUsd <= 0 && m.config.Limits.MaxBudgetUsd != nil {
		opts.MaxBudgetUsd = *m.config.Limits.MaxBudgetUsd
	}
	if m.config.Compaction != nil {
		cc := m.config.Compaction
		if opts.CompactThreshold <= 0 && cc.Threshold > 0 {
			opts.CompactThreshold = cc.Threshold
		}
		if opts.CompactTargetPercent <= 0 && cc.TargetPercent > 0 {
			opts.CompactTargetPercent = cc.TargetPercent
		}
		if opts.CompactMicroKeepTurns <= 0 && cc.MicroCompactKeep > 0 {
			opts.CompactMicroKeepTurns = cc.MicroCompactKeep
		}
		if opts.CompactMinKeepTurns <= 0 && cc.KeepTurns > 0 {
			opts.CompactMinKeepTurns = cc.KeepTurns
		}
		if opts.CompactEstimationPadding <= 0 && cc.EstimationPadding > 0 {
			opts.CompactEstimationPadding = cc.EstimationPadding
		}
		if opts.CompactEnabled == nil && cc.Enabled != nil {
			opts.CompactEnabled = cc.Enabled
		}
		if opts.CompactSummaryEnabled == nil && cc.SummaryEnabled != nil {
			opts.CompactSummaryEnabled = cc.SummaryEnabled
		}
		if opts.CompactSummaryModel == "" && cc.SummaryModel != "" {
			opts.CompactSummaryModel = cc.SummaryModel
		}
		if opts.CompactSummaryMaxTokens <= 0 && cc.SummaryMaxTokens > 0 {
			opts.CompactSummaryMaxTokens = cc.SummaryMaxTokens
		}
		if opts.CompactMemoryEnabled == nil && cc.MemoryEnabled != nil {
			opts.CompactMemoryEnabled = cc.MemoryEnabled
		}
		if opts.CompactMemoryModel == "" && cc.MemoryModel != "" {
			opts.CompactMemoryModel = cc.MemoryModel
		}
		if opts.CompactMemoryUpdateThreshold <= 0 && cc.MemoryUpdateThreshold > 0 {
			opts.CompactMemoryUpdateThreshold = cc.MemoryUpdateThreshold
		}
		if opts.CompactMemoryUpdateMinTurns <= 0 && cc.MemoryUpdateMinTurns > 0 {
			opts.CompactMemoryUpdateMinTurns = cc.MemoryUpdateMinTurns
		}
		if opts.CompactMemoryMaxTokens <= 0 && cc.MemoryMaxTokens > 0 {
			opts.CompactMemoryMaxTokens = cc.MemoryMaxTokens
		}
	}
	if m.config.Limits.SuppressSystemMessages != nil && *m.config.Limits.SuppressSystemMessages {
		opts.SuppressSystemMessages = true
	}
	if m.config.Limits.DisablePlanModeReminder != nil && *m.config.Limits.DisablePlanModeReminder {
		opts.DisablePlanModeReminder = true
	}
	if len(opts.PlanModeAllowedBashCommands) == 0 && len(m.config.Limits.PlanModeAllowedBashCommands) > 0 {
		opts.PlanModeAllowedBashCommands = m.config.Limits.PlanModeAllowedBashCommands
	}
	if m.config.Limits.DisableTurnLimitWarning != nil && *m.config.Limits.DisableTurnLimitWarning {
		opts.DisableTurnLimitWarning = true
	}
	if m.config.Limits.DisableMaxTokenContinue != nil && *m.config.Limits.DisableMaxTokenContinue {
		opts.DisableMaxTokenContinue = true
	}
	if m.config.Limits.DisableSkillSystemPrompt != nil && *m.config.Limits.DisableSkillSystemPrompt {
		opts.DisableSkillSystemPrompt = true
	}
	if m.config.WebSearch != nil && m.config.WebSearch.Mode != "" {
		opts.WebSearchMode = m.config.WebSearch.Mode
	}
}

// resolveModelTier resolves model tier aliases (e.g. "fast" -> configured fast model)
// and populates the configured fallback chain. If the tier value in models.json
// is an object {"model": "...", "fallbacks": [...]}, the fallbacks land on
// RunOptions.FallbackChain and the retry loop walks them on overload.
func resolveModelTier(opts *types.RunOptions) {
	if opts.Model == "" {
		return
	}
	resolved, fallbacks := modelconfig.ResolveTierChain(opts.Model)
	if resolved != opts.Model {
		opts.Model = resolved
	}
	if len(fallbacks) > 0 && len(opts.FallbackChain) == 0 {
		opts.FallbackChain = fallbacks
	}
}

// injectContextFiles discovers Ion-native instruction files (AGENTS.md,
// ION.md, .ion/*) plus the user's ~/.ion root, and—when the session's
// ClaudeCompat flag is set—Claude-compat files (CLAUDE.md, .claude/*) and the
// ~/.claude root, then appends them to the system prompt. The gate mirrors the
// slash-command / skill subsystem: Ion roots are unconditional, Claude roots
// are honored only when the consumer enabled ClaudeCompat.
func injectContextFiles(s *engineSession, opts *types.RunOptions) {
	if s.config.WorkingDirectory == "" {
		utils.Log("Session", "injectContextFiles: skipped (empty WorkingDirectory)")
		return
	}
	// Root sessions always walk both layers; compat follows the session flag.
	// Shares the BuildContextPrompt formatter with the dispatch path so root
	// and child produce identical `# Context from <path>` framing.
	policy := ioncontext.ResolvedPolicy{
		IncludeGlobalContext:  true,
		IncludeProjectContext: true,
		ClaudeCompat:          s.config.ClaudeCompat,
	}
	content, ctxFiles := ioncontext.BuildContextPrompt(s.config.WorkingDirectory, "root", policy)
	if s.config.ClaudeCompat {
		utils.LogWithFields(utils.LevelInfo, "session", "injectcontextfiles: claudecompat=true, discovered context file(s) (ion-native + claude-compat)", map[string]any{"count": len(ctxFiles)})
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "injectcontextfiles: claudecompat=false, discovered context file(s) (ion-native only)", map[string]any{"count": len(ctxFiles)})
	}
	for _, cf := range ctxFiles {
		utils.LogWithFields(utils.LevelDebug, "session", "injectcontextfiles: including ()", map[string]any{"path": cf.Path, "source": cf.Source})
	}
	if content != "" {
		opts.AppendSystemPrompt += content
	}
}

// injectExtensionContext fires context_inject and capability injection on each host.
func (m *Manager) injectExtensionContext(s *engineSession, key string, opts *types.RunOptions) {
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		return
	}
	var discoveredPaths []string
	if s.config.WorkingDirectory != "" {
		cfg := ioncontext.IonPreset()
		cfg.ClaudeCompat = s.config.ClaudeCompat
		ctxFiles := ioncontext.WalkContextFiles(s.config.WorkingDirectory, cfg)
		for _, cf := range ctxFiles {
			discoveredPaths = append(discoveredPaths, cf.Path)
		}
		utils.LogWithFields(utils.LevelDebug, "session", "injectextensioncontext: , discovered path(s) for context_inject", map[string]any{"claude_compat": s.config.ClaudeCompat, "count": len(discoveredPaths)})
	}

	ctx := m.newExtContext(s, key)
	injected := s.extGroup.FireContextInject(ctx, extension.ContextInjectInfo{
		WorkingDirectory: s.config.WorkingDirectory,
		DiscoveredPaths:  discoveredPaths,
	})
	for _, entry := range injected {
		opts.AppendSystemPrompt += "\n# " + entry.Label + "\n" + entry.Content + "\n"
	}

	for _, host := range s.extGroup.Hosts() {
		sdk := host.SDK()
		toolCaps := sdk.CapabilitiesByMode(extension.CapabilityModeTool)
		for _, cap := range toolCaps {
			capCopy := cap
			opts.CapabilityTools = append(opts.CapabilityTools, types.LlmToolDef{
				Name:        cap.ID,
				Description: cap.Description,
				InputSchema: cap.InputSchema,
			})
			_ = capCopy
		}
		promptCaps := sdk.CapabilitiesByMode(extension.CapabilityModePrompt)
		var capPrompt strings.Builder
		for _, cap := range promptCaps {
			capPrompt.WriteString("\n# Capability: " + cap.Name + "\n")
			capPrompt.WriteString(cap.Prompt)
			capPrompt.WriteString("\n")
		}
		if capPrompt.Len() > 0 {
			opts.CapabilityPrompt += capPrompt.String()
		}
	}
}

// injectGitContext appends formatted git context to the system prompt.
func injectGitContext(s *engineSession, opts *types.RunOptions) {
	if s.config.WorkingDirectory == "" {
		return
	}
	if gitCtx := gitcontext.GetGitContext(s.config.WorkingDirectory); gitCtx != nil {
		if formatted := gitcontext.FormatForPrompt(gitCtx); formatted != "" {
			opts.AppendSystemPrompt += "\n\n" + formatted
		}
	}
}

// injectPluginContext populates opts.InitialMessages with the plugin SessionStart
// messages so they are prepended to the provider message slice on every turn,
// matching Claude Code's hook_additional_context injection into conversation history
// (not the system prompt). The messages are already wrapped in <system-reminder>
// by loadAndWirePlugins.
func injectPluginContext(s *engineSession, opts *types.RunOptions) {
	if len(s.pluginSessionMessages) > 0 {
		opts.InitialMessages = append(opts.InitialMessages, s.pluginSessionMessages...)
	}
}
