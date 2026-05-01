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
		Prompt:        text,
		ProjectPath:   s.config.WorkingDirectory,
		SessionID:     s.conversationID,
		MaxTokens:     s.config.MaxTokens,
		Thinking:      s.config.Thinking,
		PlanMode:      s.planMode,
		PlanModeTools: s.planModeTools,
		PlanFilePath:  s.planFilePath,
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
	if opts.CompactThreshold <= 0 && m.config.Compaction != nil && m.config.Compaction.Threshold > 0 {
		opts.CompactThreshold = m.config.Compaction.Threshold
	}
}

// resolveModelTier resolves model tier aliases (e.g. "fast" -> configured fast model).
func resolveModelTier(opts *types.RunOptions) {
	if opts.Model != "" {
		if resolved := modelconfig.ResolveTier(opts.Model); resolved != opts.Model {
			opts.Model = resolved
		}
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
