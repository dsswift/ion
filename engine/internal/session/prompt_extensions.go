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
			utils.Log("Session", "per-prompt extension load failed for "+extPath+": "+err.Error())
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
		host.SetOnSendMessage(func(text string) {
			go func() {
				if err := m.SendPrompt(capturedKey, text, nil); err != nil {
					utils.Log("Session", fmt.Sprintf("ext/send_message failed: %v", err))
				}
			}()
		})
		host.SetPersistentEmit(func(ev types.EngineEvent) {
			if ev.Type == "engine_agent_state" {
				m.mu.Lock()
				s.lastExtAgentStates = make([]types.AgentStateUpdate, len(ev.Agents))
				copy(s.lastExtAgentStates, ev.Agents)
				m.mu.Unlock()
			}
			m.emit(capturedKey, ev)
		})
	}
	s.extGroup = group
	ctx := m.newExtContext(s, key)
	_ = group.FireSessionStart(ctx)
}

// fireBeforeAgentStart fires before_agent_start for primary system prompt injection.
// (outside lock -- hook response may include events that call m.emit)
func (m *Manager) fireBeforeAgentStart(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions) {
	if extGroup == nil || extGroup.IsEmpty() || skipExtensions {
		return
	}
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: firing before_agent_start", key))
	basCtx := m.newExtContext(s, key)
	agentSysPrompt, _ := extGroup.FireBeforeAgentStart(basCtx, extension.AgentInfo{})
	if agentSysPrompt != "" {
		opts.AppendSystemPrompt += "\n\n" + agentSysPrompt
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: before_agent_start injected %d chars", key, len(agentSysPrompt)))
	}
}

// fireBeforePromptCli fires the before_prompt hook for CliBackend runs.
// ApiBackend wires this hook inside buildRunConfig; CliBackend skips that path,
// so we fire the hook here and materialise the result into RunOptions before
// the subprocess is launched. No-op when the backend is not CliBackend.
func (m *Manager) fireBeforePromptCli(s *engineSession, key string, extGroup *extension.ExtensionGroup, skipExtensions bool, opts *types.RunOptions) {
	if _, isCli := m.backend.(*backend.CliBackend); !isCli {
		return
	}
	if extGroup == nil || extGroup.IsEmpty() || skipExtensions {
		return
	}
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: firing before_prompt (cli)", key))
	ctx := m.newExtContext(s, key)
	rewritten, extraSystem, err := extGroup.FireBeforePrompt(ctx, opts.Prompt)
	if err != nil {
		utils.Log("Session", fmt.Sprintf("before_prompt hook error (cli): %v", err))
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
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: firing model_select (requested=%s)", key, opts.Model))
	msCtx := m.newExtContext(s, key)
	if overridden, _ := extGroup.FireModelSelect(msCtx, extension.ModelSelectInfo{
		RequestedModel: opts.Model,
	}); overridden != "" {
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: model_select override: %s -> %s", key, opts.Model, overridden))
		opts.Model = overridden
	}
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: model_select complete", key))
}
