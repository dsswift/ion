package session

import (
	"fmt"
	"os"
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
	// Attachments are pre-encoded images supplied by the client to be sent
	// to the LLM as native image content blocks alongside the text prompt.
	Attachments []types.ImageAttachment
	// ImplementationPhase forwards the client's
	// ClientCommand.ImplementationPhase flag onto the run's RunOptions so
	// the engine suppresses EnterPlanMode injection. Optional; defaults
	// to false. See the field comment on types.RunOptions for the full
	// rationale.
	ImplementationPhase bool
	// EnterPlanModeDescription forwards the client's harness-supplied
	// description prose for the EnterPlanMode sentinel tool. When
	// non-empty, the engine uses this string verbatim as the tool's
	// description. When empty (the default), the engine falls back to a
	// one-line neutral default. Per ADR-004, the policy prose lives in
	// the harness; the engine ships only the mechanism.
	EnterPlanModeDescription string
	// PlanModeSparseReminder forwards the client's harness-supplied text
	// for the per-turn plan-mode sparse reminder. When non-empty, the
	// engine injects this string instead of buildPlanModeSparseReminder.
	// When empty (the default), the engine builds the reminder from the
	// plan file path. Parallel override to EnterPlanModeDescription;
	// same additive omitempty contract.
	PlanModeSparseReminder string
	// PlanFilePath is the persisted plan file path from the desktop's
	// tab state. When non-empty, the engine restores the session's
	// planFilePath from this value instead of allocating a fresh slug —
	// preserving plan file continuity across desktop restarts. The
	// engine validates that the file exists on disk before using it;
	// if missing it falls back to fresh allocation. Additive optional
	// field; empty by default.
	PlanFilePath string

	// BashAllowlistAdditionsForThisPrompt are per-prompt additions to
	// the plan-mode Bash allowlist. The engine unions these with the
	// session-scoped allowlist (engineSession.planModeAllowedBashCommands)
	// when building the run-time tool list, then drops them at run end —
	// the session-level allowlist is NEVER mutated. Intended carrier:
	// slash-command frontmatter that needs a one-turn permission
	// extension. See types.RunOptions.BashAllowlistAdditionsForThisPrompt
	// for the wire-side contract. Additive optional field; nil/empty
	// for prompts that don't need per-prompt additions.
	BashAllowlistAdditionsForThisPrompt []string

	// CompactTargetPercent overrides the post-compact target as a percentage of
	// the context window. Zero means "use engine default".
	CompactTargetPercent float64

	// CompactMicroKeepTurns overrides the number of recent turns protected
	// from micro-compaction. Zero means "use engine default".
	CompactMicroKeepTurns int

	// CompactEnabled overrides the auto-compact gate. nil means "use engine
	// default"; false disables proactive compaction for this prompt.
	CompactEnabled *bool

	// CompactSummaryEnabled overrides whether LLM-based summarization is used
	// during compaction. nil means "use engine default".
	CompactSummaryEnabled *bool

	// CompactMemoryEnabled overrides whether the background session memory
	// summarizer is active. nil means "use engine default".
	CompactMemoryEnabled *bool
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
	s.cliTurnNumber = 0
	s.cliTurnActive = false

	if s.planMode && s.planFilePath == "" {
		// Try to restore a persisted plan file path from the client
		// (desktop sends this from tab state after restarts). Only used
		// when the file still exists on disk; otherwise fall through to
		// fresh allocation.
		if overrides != nil && overrides.PlanFilePath != "" {
			if _, err := os.Stat(overrides.PlanFilePath); err == nil {
				s.planFilePath = overrides.PlanFilePath
				utils.Info("PlanMode", fmt.Sprintf(
					"SendPrompt: key=%s restored planFile=%s from client",
					key, s.planFilePath))
			} else {
				utils.Info("PlanMode", fmt.Sprintf(
					"SendPrompt: key=%s client planFilePath=%s not on disk, allocating new",
					key, overrides.PlanFilePath))
				s.planFilePath = allocateNewPlanFilePath(m.backend, s.config.WorkingDirectory)
				utils.Info("PlanMode", fmt.Sprintf("SendPrompt: key=%s allocated new planFile=%s", key, s.planFilePath))
			}
		} else {
			// Plan file allocation is centralised in allocateNewPlanFilePath
			// (plan_slug.go). That helper handles the CLI/Hybrid-vs-API
			// directory choice and produces a fresh non-colliding word slug.
			// See its doc comment for the directory selection rules.
			s.planFilePath = allocateNewPlanFilePath(m.backend, s.config.WorkingDirectory)
			utils.Info("PlanMode", fmt.Sprintf("SendPrompt: key=%s allocated new planFile=%s", key, s.planFilePath))
		}
	}

	// Detect plan mode reentry: plan mode is active, we already have a plan
	// file path (preserved from a previous exit), and the session previously
	// exited plan mode via ExitPlanMode.
	planModeReentry := s.planMode && s.planFilePath != "" && s.hasExitedPlanMode

	opts := buildRunOptions(s, text, overrides)
	if planModeReentry {
		opts.PlanModeReentry = true
		utils.Info("PlanMode", fmt.Sprintf("key=%s reentry detected, planFile=%s", key, s.planFilePath))
	}
	m.applyConfigDefaults(&opts)
	resolveModelTier(&opts)

	// When the resolved model is the engine default and the session has a
	// conversation-seeded model, prefer the conversation's model. This
	// preserves the model across desktop restarts where the tab UUID changes
	// and the desktop loses its engineModelOverrides. The user can still
	// explicitly override by selecting a different model in the picker.
	if s.lastModel != "" && m.config != nil && opts.Model == m.config.DefaultModel && opts.Model != s.lastModel {
		utils.Log("Session", fmt.Sprintf("prompt_dispatch: key=%s overriding default model %s with conversation model %s", key, opts.Model, s.lastModel))
		opts.Model = s.lastModel
	}

	injectContextFiles(s, &opts)
	m.injectExtensionContext(s, key, &opts)
	injectGitContext(s, &opts)

	// Inject session memory into the system prompt so the model has context
	// from previously compacted conversation history. Only fires when memory
	// is non-empty (i.e. a prior session generated a summary).
	if s.sessionMemory != nil {
		s.sessionMemory.InjectMemoryIntoSystemPrompt(&opts)
	}

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
	// closures. Without this, two parallel sessions would see each other's
	// extension context, MCP tools, and agent spawn rules.
	//
	// resolvedBackend(opts.Model) collapses the hybrid case: for plain
	// CliBackend/ApiBackend it returns m.backend as-is; for HybridBackend
	// it returns the inner backend that will actually handle this model.
	var runCfg *backend.RunConfig
	if apiBackend, ok := m.resolvedBackend(opts.Model).(*backend.ApiBackend); ok {
		runCfg = m.buildRunConfig(s, key, requestID, apiBackend, extGroup, skipExtensions, permEng, telemCollector, mcpConns, opts.Model)
	}

	m.wirePermissionHookServer(s, key, &opts, permEng)
	m.wireToolServer(s, key, &opts, extGroup)
	m.wireAgentToolServer(s, key, &opts)

	// Fire before_prompt for CliBackend (ApiBackend wires this inside buildRunConfig).
	m.fireBeforePromptCli(s, key, extGroup, skipExtensions, &opts)

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

	m.mu.Lock()
	s.lastModel = opts.Model
	s.lastContextWindow = promptCtxWindow
	// Clear any retained permission denials from a prior task_complete —
	// the user is dispatching a new prompt, which is implicitly the answer
	// to (or dismissal of) the previous AskUserQuestion / ExitPlanMode.
	// Without this, a subsequent ReconcileState would re-surface a stale
	// denial on top of an in-flight prompt, contradicting the session's
	// current state.
	if len(s.lastPermissionDenials) > 0 {
		utils.Log("Session", fmt.Sprintf("prompt_dispatch: key=%s clearing %d retained permission_denials (new prompt supersedes)", key, len(s.lastPermissionDenials)))
		s.lastPermissionDenials = nil
	}
	lastPct := s.lastContextPct
	m.mu.Unlock()

	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			Label: key, State: "running", Model: opts.Model,
			ContextWindow:  promptCtxWindow,
			ContextPercent: lastPct,
		},
	})

	// Dispatch to backend. ApiBackend uses the per-run config built above so
	// every closure on this run sees this session's hooks/tools/perms.
	// CliBackend ignores runCfg and follows its own subprocess wiring.
	//
	// HybridBackend implements both StartRun and StartRunWithConfig: it
	// records the routing decision for opts.Model and forwards to the
	// inner *ApiBackend (with runCfg) or inner *CliBackend (without).
	// We dispatch through m.backend here (not resolvedBackend) so the
	// hybrid layer sees the call and can record its routing table entry
	// before forwarding.
	if hybrid, ok := m.backend.(*backend.HybridBackend); ok {
		hybrid.StartRunWithConfig(requestID, opts, runCfg)
	} else if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
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
		pp.attachments = overrides.Attachments
		pp.implementationPhase = overrides.ImplementationPhase
	}
	s.promptQueue = append(s.promptQueue, pp)
	utils.Log("Session", fmt.Sprintf("prompt queued for %s (%d in queue)", key, len(s.promptQueue)))
	return false, nil
}
