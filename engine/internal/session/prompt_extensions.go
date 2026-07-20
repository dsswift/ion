package session

import (
	"fmt"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// lateLoadExtensions loads per-prompt extensions if the override provides them
// and the session has no current extension group. Caller must hold m.mu.
func (m *Manager) lateLoadExtensions(s *engineSession, key string, overrides *PromptOverrides) {
	if overrides == nil || len(overrides.Extensions) == 0 {
		return
	}
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		return
	}

	group := extension.NewExtensionGroup()
	for _, extPath := range overrides.Extensions {
		host := extension.NewHost()
		if m.config != nil && m.config.Timeouts != nil {
			host.SetRPCTimeout(m.config.Timeouts.ExtensionRpc())
		}
		if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.RequiredHooks) > 0 {
			hooks := make([]struct{ Event, Handler string }, len(m.config.Enterprise.RequiredHooks))
			for i, h := range m.config.Enterprise.RequiredHooks {
				hooks[i] = struct{ Event, Handler string }{Event: h.Event, Handler: h.Handler}
			}
			host.RegisterRequiredHooks(hooks)
		}
		extCfg := &extension.ExtensionConfig{
			ExtensionDir:     filepath.Dir(extPath),
			WorkingDirectory: s.config.WorkingDirectory,
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
		// Bind session/conversation IDs so extension log notifications are
		// stamped with the correlating IDs (unified log schema).
		host.BindSession(s.key, s.conversationID)
		host.SetOnSendMessage(func(payload extension.SendPromptPayload) {
			// Shared dispatch body (prompt_options.go) so this late-loaded-
			// extension path produces identical run configuration to the
			// primary wiring in start_session.go. The two sites must not diverge.
			go m.dispatchSendPromptPayload(capturedKey, "prompt_extensions", payload)
		})
		// Wire the per-handler hook_latency telemetry sink (mirrors the primary
		// wiring in start_session.go — the two sites must not diverge). Nil sink
		// when the session has no collector; callHook then emits nothing.
		if s.telemetry != nil {
			host.SetTelemetrySink(s.telemetry.Event)
		}
		host.SetPersistentEmit(func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				// Cache the extension's roster, then re-emit a merged snapshot
				// that includes engine-managed entries (dispatch state with
				// task, conversationId, progress). Forwarding the extension's
				// raw event would overwrite engine-managed entries on the
				// desktop due to the complete-snapshot contract.
				s.agents.CacheExtStates(ev.Agents)
				merged := s.agents.MergedSnapshot()
				utils.LogWithFields(utils.LevelInfo, "session", "agent_snapshot_emitted reason=ext_emit_merged", map[string]any{"captured_key": capturedKey, "count": len(merged)})
				m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: merged})
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
	s.extGroup = group
	// Capture extension identity for telemetry attribution (run.complete /
	// llm.call ctx.extension). Same capture as loadAndWireExtensions — the
	// two wiring sites must not diverge. Caller holds m.mu, so no extra
	// locking here. Name resolves manifest → init-handshake → directory
	// basename (host_lifecycle.go / parseInitResult); Version is
	// manifest-only.
	for _, h := range group.Hosts() {
		if s.extensionName == "" && h.Name() != "" {
			s.extensionName = h.Name()
		}
		if s.extensionVersion == "" && h.Version() != "" {
			s.extensionVersion = h.Version()
		}
	}
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
