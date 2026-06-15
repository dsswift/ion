package session

import (
	"strings"

	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/gitcontext"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/types"
)

func buildRunOptions(s *engineSession, text string, overrides *PromptOverrides) types.RunOptions {
	opts := types.RunOptions{
		Prompt:      text,
		ProjectPath: s.config.WorkingDirectory,
		// SessionID is Ion's conversation-file identity. The API backend
		// uses it to load/create ~/.ion/conversations/<id>.* and to resume.
		SessionID: s.conversationID,
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

// injectContextFiles discovers CLAUDE.md/ION.md files and appends them to the system prompt.
func injectContextFiles(s *engineSession, opts *types.RunOptions) {
	if s.config.WorkingDirectory == "" {
		return
	}
	ctxFiles := ioncontext.WalkContextFiles(s.config.WorkingDirectory, ioncontext.IonPreset())
	var ctxContent strings.Builder
	for _, cf := range ctxFiles {
		ctxContent.WriteString("\n# Context from " + cf.Path + "\n")
		ctxContent.WriteString(cf.Content)
		ctxContent.WriteString("\n")
	}
	if ctxContent.Len() > 0 {
		opts.AppendSystemPrompt += ctxContent.String()
	}
}

// injectExtensionContext fires context_inject and capability injection on each host.
func (m *Manager) injectExtensionContext(s *engineSession, key string, opts *types.RunOptions) {
	if s.extGroup == nil || s.extGroup.IsEmpty() {
		return
	}
	var discoveredPaths []string
	if s.config.WorkingDirectory != "" {
		ctxFiles := ioncontext.WalkContextFiles(s.config.WorkingDirectory, ioncontext.IonPreset())
		for _, cf := range ctxFiles {
			discoveredPaths = append(discoveredPaths, cf.Path)
		}
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
