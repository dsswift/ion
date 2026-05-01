package session

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// PromptOverrides holds per-prompt overrides from the client command.
type PromptOverrides struct {
	Model              string
	MaxTurns           int
	MaxBudgetUsd       float64
	Extensions         []string
	NoExtensions       bool
	AppendSystemPrompt string
}

// SendPrompt dispatches a prompt to the session's backend run.
func (m *Manager) SendPrompt(key, text string, overrides *PromptOverrides) (retErr error) {
	defer func() {
		if r := recover(); r != nil {
			msg := fmt.Sprintf("PANIC in SendPrompt key=%s: %v", key, r)
			utils.Error("Session", msg)
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: msg,
				ErrorCode:    "internal_panic",
			})
			retErr = fmt.Errorf("%s", msg)
		}
	}()

	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: fmt.Sprintf("session %q not found", key),
			ErrorCode:    "session_not_found",
		})
		return fmt.Errorf("session %q not found", key)
	}
	if s.requestID != "" {
		queueFull, err := m.enqueueIfBusy(s, key, text, overrides)
		m.mu.Unlock()
		if queueFull {
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: err.Error(),
				ErrorCode:    "queue_full",
			})
		}
		return err
	}

	requestID := fmt.Sprintf("%s-%d", key, time.Now().UnixMilli())
	s.requestID = requestID

	if s.planMode && s.planFilePath == "" {
		home, _ := os.UserHomeDir()
		plansDir := filepath.Join(home, ".ion", "plans")
		os.MkdirAll(plansDir, 0755)
		s.planFilePath = filepath.Join(plansDir, generatePlanID()+".md")
	}

	opts := buildRunOptions(s, text, overrides)
	m.applyConfigDefaults(&opts)
	resolveModelTier(&opts)
	injectContextFiles(s, &opts)
	m.injectExtensionContext(s, key, &opts)
	injectGitContext(s, &opts)

	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: releasing lock, model=%s", key, opts.Model))

	// G07: Enterprise model enforcement
	if m.config != nil && m.config.Enterprise != nil {
		if !ionconfig.IsModelAllowed(opts.Model, m.config.Enterprise) {
			m.mu.Unlock()
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("model %q not allowed by enterprise policy", opts.Model),
			})
			return fmt.Errorf("model %q not allowed by enterprise policy", opts.Model)
		}
	}

	m.lateLoadExtensions(s, key, overrides)

	skipExtensions := overrides != nil && overrides.NoExtensions

	extGroup := s.extGroup
	permEng := s.permEngine
	telemCollector := s.telemetry
	mcpConns := s.mcpConns
	m.mu.Unlock()
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: lock released", key))

	m.fireBeforeAgentStart(s, key, extGroup, skipExtensions, &opts)

	// Clear any working message left by before_agent_start hook
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	m.fireModelSelect(s, key, extGroup, skipExtensions, &opts)

	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: building backend run config", key))

	// Build the per-run RunConfig that travels with this run on the backend.
	// Storing hooks/perm engine/external tools/agent spawner on each run --
	// rather than mutating shared state on the singleton ApiBackend --
	// guarantees that concurrent sessions cannot trample each other's
	// closures. Without this, two desktop tabs running in parallel would
	// see each other's extension context, MCP tools, and agent spawn rules.
	var runCfg *backend.RunConfig
	if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		runCfg = m.buildRunConfig(s, key, requestID, apiBackend, extGroup, skipExtensions, permEng, telemCollector, mcpConns, opts.Model)
	}

	m.wirePermissionHookServer(s, key, &opts, permEng)
	m.wireToolServer(s, key, &opts, extGroup)

	m.mu.RLock()
	if len(s.suppressedTools) > 0 {
		opts.SuppressTools = append(opts.SuppressTools, s.suppressedTools...)
	}
	m.mu.RUnlock()

	utils.Info("Session", fmt.Sprintf("dispatching prompt: key=%s requestID=%s model=%s", key, requestID, opts.Model))
	promptCtxWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(opts.Model); info != nil {
		promptCtxWindow = info.ContextWindow
	}
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "running", Model: opts.Model, ContextWindow: promptCtxWindow},
	})

	// Dispatch to backend. ApiBackend uses the per-run config built above so
	// every closure on this run sees this session's hooks/tools/perms.
	// CliBackend ignores runCfg and follows its own subprocess wiring.
	if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		apiBackend.StartRunWithConfig(requestID, opts, runCfg)
	} else {
		m.backend.StartRun(requestID, opts)
	}
	return nil
}

// enqueueIfBusy queues the prompt onto a running session. Returns
// (queueFull, err): when queueFull the caller emits the error event after
// dropping the lock; when err is nil the prompt was queued successfully.
// Caller must hold m.mu.
func (m *Manager) enqueueIfBusy(s *engineSession, key, text string, overrides *PromptOverrides) (bool, error) {
	if len(s.promptQueue) >= s.maxQueueDepth {
		return true, fmt.Errorf("session %q prompt queue full (%d)", key, s.maxQueueDepth)
	}
	pp := pendingPrompt{text: text}
	if overrides != nil {
		pp.model = overrides.Model
		pp.maxTurns = overrides.MaxTurns
		pp.maxBudgetUsd = overrides.MaxBudgetUsd
		pp.extensions = overrides.Extensions
		pp.noExtensions = overrides.NoExtensions
	}
	s.promptQueue = append(s.promptQueue, pp)
	utils.Log("Session", fmt.Sprintf("prompt queued for %s (%d in queue)", key, len(s.promptQueue)))
	return false, nil
}
