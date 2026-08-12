package session

import (
	"fmt"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// lateLoadExtensions loads per-prompt extensions if the override provides them
// and the session has no current extension group. Self-locking: caller must NOT
// hold m.mu. I/O-heavy (subprocess spawn, host.Load), so runs off-lock.
func (m *Manager) lateLoadExtensions(s *engineSession, key string, overrides *PromptOverrides) {
	if overrides == nil || len(overrides.Extensions) == 0 {
		return
	}
	m.mu.RLock()
	alreadyLoaded := s.extGroup != nil && !s.extGroup.IsEmpty()
	m.mu.RUnlock()
	if alreadyLoaded {
		return
	}

	// Snapshot config under RLock, then release before I/O.
	m.mu.RLock()
	var rpcTimeout time.Duration
	var requiredHooks []struct{ Event, Handler string }
	if m.config != nil && m.config.Timeouts != nil {
		rpcTimeout = m.config.Timeouts.ExtensionRpc()
	}
	if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.RequiredHooks) > 0 {
		requiredHooks = make([]struct{ Event, Handler string }, len(m.config.Enterprise.RequiredHooks))
		for i, h := range m.config.Enterprise.RequiredHooks {
			requiredHooks[i] = struct{ Event, Handler string }{Event: h.Event, Handler: h.Handler}
		}
	}
	m.mu.RUnlock()

	group := extension.NewExtensionGroup()
	for _, extPath := range overrides.Extensions {
		host := extension.NewHost()
		extCfg := &extension.ExtensionConfig{
			ExtensionDir:     filepath.Dir(extPath),
			WorkingDirectory: s.config.WorkingDirectory,
		}
		if rpcTimeout > 0 {
			host.SetRPCTimeout(rpcTimeout)
		}
		if len(requiredHooks) > 0 {
			host.RegisterRequiredHooks(requiredHooks)
		}
		if err := host.Load(extPath, extCfg); err != nil {
			stderrTail := host.StderrTail()
			utils.LogWithFields(utils.LevelError, "session", "per-prompt extension load failed", map[string]any{"ext_path": extPath, "error": err.Error()})
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension load failed: %s", err.Error()),
				ErrorCode:    "extension_load_failed",
				StderrTail:   stderrTail,
			})
			continue
		}
		capturedKey := key
		host.SetOnDeath(func(h *extension.Host) {
			m.handleHostDeath(capturedKey, h)
		})
		group.Add(host)
	}
	if group.IsEmpty() {
		return
	}

	for _, host := range group.Hosts() {
		capturedKey := key
		host.BindSession(s.key, s.conversationID)
		host.SetOnSendMessage(func(payload extension.SendPromptPayload) {
			go m.dispatchSendPromptPayload(capturedKey, "prompt_extensions", payload)
		})
		if s.telemetry != nil {
			host.SetTelemetrySink(s.telemetry.Event)
		}
		host.SetPersistentEmit(func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				m.cacheExtStatesAndEmit(capturedKey, s, ev.Agents)
				return
			}
			if ev.Type == "engine_status" && ev.Fields != nil && ev.Fields.ExtensionName != "" {
				m.mu.Lock()
				s.extensionName = ev.Fields.ExtensionName
				m.mu.Unlock()
			}
			m.emit(capturedKey, ev)
		})
	}

	// Brief lock to write session state.
	m.mu.Lock()
	s.extGroup = group
	for _, h := range group.Hosts() {
		if s.extensionName == "" && h.Name() != "" {
			s.extensionName = h.Name()
		}
		if s.extensionVersion == "" && h.Version() != "" {
			s.extensionVersion = h.Version()
		}
	}
	m.mu.Unlock()

	ctx := m.newExtContext(s, key)
	group.FireSessionStart(ctx) //nolint:errcheck // errors logged internally by fireVoid/s.fire
}

// fireBeforeAgentStart fires before_agent_start for primary system prompt injection.
// (outside lock -- hook response may include events that call m.emit)
func (m *Manager) fireBeforeAgentStart(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions) {
	if extGroup == nil || extGroup.IsEmpty() || skipExtensions {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: firing before_agent_start", map[string]any{"key": key})
	basCtx := m.newExtContext(s, key)
	agentSysPrompt, _, _ := extGroup.FireBeforeAgentStart(basCtx, extension.AgentInfo{IsRoot: true}) //nolint:errcheck // errors logged internally by fireVoid/s.fire
	if agentSysPrompt != "" {
		opts.AppendSystemPrompt += "\n\n" + agentSysPrompt
		utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: before_agent_start injected chars", map[string]any{"key": key, "count": len(agentSysPrompt)})
	}
}

// fireBeforePromptCli fires the before_prompt hook for ClaudeCodeBackend runs.
// ApiBackend wires this hook inside buildRunConfig; ClaudeCodeBackend skips that path,
// so we fire the hook here and materialise the result into RunOptions before
// the subprocess is launched. No-op when the backend is not ClaudeCodeBackend.
//
// Under HybridBackend, this only fires when the model resolves to the
// inner *ClaudeCodeBackend (Anthropic models). API-routed hybrid runs use the
// ApiBackend's buildRunConfig path for before_prompt, identical to plain
// "backend": "api".
func (m *Manager) fireBeforePromptCli(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions) {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.ClaudeCodeBackend); !isCli {
		return
	}
	if extGroup == nil || extGroup.IsEmpty() || skipExtensions {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: firing before_prompt (cli)", map[string]any{"key": key})
	ctx := m.newExtContext(s, key)
	// Populate ctx.Model with the SELECTED model (opts.Model is already the
	// routed model at this point, post model_select) so a before_prompt handler
	// can adapt the prompt to the chosen model — the payload half of the
	// model_select→before_prompt handoff.
	ctx.Model = modelRefFor(opts.Model)
	rewritten, extraSystem, err := extGroup.FireBeforePrompt(ctx, opts.Prompt)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "before_prompt hook error (cli)", map[string]any{"error": err})
		return
	}
	if rewritten != "" {
		opts.Prompt = rewritten
	}
	if extraSystem != "" {
		if opts.AppendSystemPrompt == "" {
			opts.AppendSystemPrompt = extraSystem
		} else {
			opts.AppendSystemPrompt += "\n\n" + extraSystem
		}
	}
}

// fireModelSelect fires model_select hook outside lock; hook may emit events.
func (m *Manager) fireModelSelect(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions) {
	if extGroup == nil || extGroup.IsEmpty() || skipExtensions {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: firing model_select ()", map[string]any{"key": key, "model": opts.Model})
	msCtx := m.newExtContext(s, key)
	if overridden, _ := extGroup.FireModelSelect(msCtx, extension.ModelSelectInfo{ //nolint:errcheck // errors logged internally by fireVoid/s.fire
		RequestedModel: opts.Model,
		Prompt:         opts.Prompt,
	}); overridden != "" {
		utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: model_select override: ->", map[string]any{"key": key, "model": opts.Model, "run_id": overridden})
		opts.Model = overridden
	}
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: model_select complete", map[string]any{"key": key})
}
