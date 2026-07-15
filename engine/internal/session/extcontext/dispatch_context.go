package extcontext

import (

	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// toDispatchContextConfig converts an extension.ContextPolicy (the SDK-facing
// tri-state struct) into the types.DispatchContextConfig the context-package
// cascade consumes. Returns nil for a nil input so nil propagates as "inherit".
func toDispatchContextConfig(p *extension.ContextPolicy) *types.DispatchContextConfig {
	if p == nil {
		return nil
	}
	return &types.DispatchContextConfig{
		IncludeGlobalContext:  p.IncludeGlobalContext,
		IncludeProjectContext: p.IncludeProjectContext,
		ClaudeCompat:          p.ClaudeCompat,
	}
}

// injectDispatchContext resolves the effective context policy for a dispatch,
// walks the context files rooted at the child's projectPath, and prepends the
// formatted content to opts.SystemPrompt AHEAD of any agent persona (so
// grounding precedes role definition).
//
// Resolution order: perDispatch (level 4) > sessionDefault (level 3) > engine
// engine.json dispatchContext (level 2) > built-in default (level 1: all on).
//
// The walk is rooted at projectPath (the child's cwd), not the parent's. This
// gives each dispatch its own context tree: a dispatch working in engine/ picks
// up engine/AGENTS.md; a cross-repo dispatch gets that repo's tree.
func injectDispatchContext(
	agentName string,
	projectPath string,
	opts *extension.DispatchAgentOpts,
	sa SessionAccessor,
) {
	if projectPath == "" {
		utils.LogWithFields(utils.LevelInfo, "server", "dispatch context injection skipped: empty projectpath", map[string]any{"agent_name": agentName, "session_key": sa.SessionKey()})
		return
	}

	// Level 2: engine.json dispatchContext (from the machine-wide config).
	var engineDispatchCfg *types.DispatchContextConfig
	if cfg := sa.EngineConfig(); cfg != nil {
		engineDispatchCfg = cfg.DispatchContext
	}
	// The engine's session-level ClaudeCompat seeds the compat field before any
	// explicit policy override is applied.
	engineCompatDefault := sa.ClaudeCompat()

	// Level 3: session default set by an extension via setDispatchContextDefaults.
	sessionDefaultCfg := toDispatchContextConfig(sa.GetDispatchContextDefaults())

	// Level 4: the per-dispatch override on this DispatchAgentOpts.
	perDispatchCfg := toDispatchContextConfig(opts.ContextPolicy)

	// Resolve the effective policy across all four levels.
	policy := ioncontext.ResolvePolicy(perDispatchCfg, sessionDefaultCfg, engineDispatchCfg, engineCompatDefault)

	utils.LogWithFields(utils.LevelInfo, "server", "dispatch context policy resolved", map[string]any{"agent_name": agentName, "session_key": sa.SessionKey(), "include_global_context": policy.IncludeGlobalContext, "include_project_context": policy.IncludeProjectContext, "claude_compat": policy.ClaudeCompat, "project_path": projectPath})

	if !policy.IncludeGlobalContext && !policy.IncludeProjectContext {
		utils.LogWithFields(utils.LevelInfo, "server", "dispatch context injection suppressed: both layers disabled", map[string]any{"agent_name": agentName, "session_key": sa.SessionKey()})
		return
	}

	content, files := ioncontext.BuildContextPrompt(projectPath, agentName, policy)
	if content == "" {
		utils.LogWithFields(utils.LevelInfo, "server", "dispatch context injection: no context files found", map[string]any{"agent_name": agentName, "project_path": projectPath, "session_key": sa.SessionKey()})
		return
	}

	totalBytes := 0
	paths := make([]string, 0, len(files))
	for _, f := range files {
		totalBytes += len(f.Content)
		paths = append(paths, f.Path)
	}
	utils.LogWithFields(utils.LevelInfo, "server", "dispatch context injected", map[string]any{"agent_name": agentName, "session_key": sa.SessionKey(), "count": len(files), "total_bytes": totalBytes, "paths": paths})

	// Prepend context AHEAD of the agent persona (opts.SystemPrompt). Order:
	// context grounding -> agent persona. This mirrors how injectContextFiles
	// grounds root sessions before their own system-prompt content.
	if opts.SystemPrompt != "" {
		opts.SystemPrompt = content + "\n" + opts.SystemPrompt
	} else {
		opts.SystemPrompt = content
	}
}
