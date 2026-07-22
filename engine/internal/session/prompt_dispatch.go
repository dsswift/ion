package session

import (
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
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
	// ThinkingEffort forwards the client's ClientCommand.ThinkingEffort onto
	// the run's RunOptions.Thinking for this prompt. One of "low"|"medium"|
	// "high"; "" or "off" means no thinking directive for this prompt
	// (overriding any session default to off). The live per-conversation
	// control: a client changes the level and it applies on the next prompt
	// with no session restart. Mirrors ImplementationPhase's per-prompt
	// override semantics.
	ThinkingEffort string
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

	// ResolveSlash signals that the prompt Text is a slash-command invocation
	// the engine should resolve and expand (see protocol.ClientCommand.ResolveSlash
	// and types.RunOptions.ResolveSlash). When true, SendPrompt resolves the
	// invocation against the conventional roots, rewrites the LLM-visible prompt
	// to the expanded body, and persists the raw invocation as the display turn.
	ResolveSlash bool
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
	// Busy check: a run is in flight (s.requestID != "") OR an async
	// user-initiated compaction is running (s.compactInFlight). The latter
	// does not set s.requestID — its synthetic runID is unregistered in the
	// backend — so without this second condition a prompt submitted during
	// compaction would start a real run whose load-mutate-save clobbers the
	// compaction's own save. Enqueue instead; the compaction goroutine drains
	// one queued prompt when it finishes (mirroring handleRunExit). See
	// dispatchCompact and engineSession.compactInFlight.
	if s.requestID != "" || s.compactInFlight {
		if s.requestID == "" && s.compactInFlight {
			utils.LogWithFields(utils.LevelInfo, "session", "sendprompt: enqueued behind in-flight compaction (compactinflight=true, no active run)", map[string]any{"key": key})
		}
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
	// Mark the dispatch-in-flight window so currentSessionStatus does not
	// misread the not-yet-registered run as stale and destructively clear
	// s.requestID (the state=idle-for-a-live-run bug). The deferred clear
	// covers every exit from this function — the early-abort paths, the
	// normal return after the backend Start* call (registration is
	// synchronous inside it), and panic unwind. It is run-scoped: it clears
	// only while the marker still belongs to THIS requestID, so a fast run
	// that exits and dequeues the next prompt before this frame returns
	// cannot strip the NEW dispatch's window. See
	// engineSession.dispatchingRunID.
	s.dispatchingRunID = requestID
	defer func() {
		m.mu.Lock()
		if cur, ok := m.sessions[key]; ok && cur.dispatchingRunID == requestID {
			cur.dispatchingRunID = ""
		}
		m.mu.Unlock()
	}()
	// Bind runID -> key for event routing, independent of the transient
	// s.requestID (which currentSessionStatus may clear mid-run). Held under
	// m.mu here, same as the s.requestID assignment above. Cleared at the
	// terminal points: handleRunExit and the early-abort paths below.
	m.bindRunLocked(requestID, key)
	s.cliTurnNumber = 0
	s.cliTurnActive = false

	// Re-arm the session cancellation root if a prior abort (SendAbort) or a
	// stalled-run cancellation left it cancelled. Done under the manager lock,
	// at the new-run seam, BEFORE opts.ParentCtx = s.rootContext() below — so
	// this run derives from a LIVE root instead of a dead one. Without this a
	// session that was ever aborted is wedged: every subsequent run would be
	// born cancelled and exit instantly with signal=cancelled, recoverable only
	// by restarting the engine. The busy-guard above (s.requestID != "") means
	// no run is in flight here, so re-creating the root cannot orphan a live
	// descendant. No-op when the root is still live. See session_root_context.go.
	s.rearmRootContextIfCancelled()

	// Build run options and finalise the model BEFORE allocating the plan file
	// path. The allocation must know the resolved serving backend (api vs
	// claude-code) to choose the correct plans directory; that requires the
	// model to be final so m.resolvedBackend(opts.Model) returns the right
	// inner backend. Previously this block ran first with m.backend (the static
	// HybridBackend wrapper), which caused every hybrid run — regardless of
	// which inner backend actually served it — to be treated as CLI-scoped and
	// write plans to <project>/.ion/plans/.
	opts := buildRunOptions(s, text, overrides)

	// Slash-command resolution + expansion. When the client flagged this prompt
	// as a slash invocation, resolve the template across the conventional roots
	// and rewrite opts.Prompt to the EXPANDED body; the runloop persists the raw
	// invocation as the display turn. An unresolved invocation aborts the prompt
	// with an unknown_command result (no run starts) so the consumer can surface
	// it, matching the command-dispatch contract. Extension commands are NOT
	// handled here — those route through SendCommand; this path owns the
	// .md/skill/template resolution that was formerly a per-consumer fallback.
	if overrides != nil && overrides.ResolveSlash {
		resolved, failedCmd := m.resolveSlashIntoOpts(s, key, &opts)
		if !resolved {
			m.mu.Unlock()
			s.requestID = ""
			m.unbindRun(requestID)
			m.emitUnknownCommand(key, failedCmd)
			return nil
		}
	}

	// Extension-command slash provenance. When an extension command handler
	// (dispatchCommand → cmd.Execute → ctx.sendPrompt) initiated this prompt,
	// the session carries pendingSlashInvocation with the raw command/args.
	// Consume it so the run loop persists the raw invocation as the display
	// turn (with slashCommand/slashArgs provenance) instead of the expanded
	// body. Only applies when resolveSlashIntoOpts did NOT already set the
	// fields (the pending is the fallback for the extension-command path).
	if s.pendingSlashInvocation != nil && opts.ResolvedSlashCommand == "" {
		opts.ResolvedSlashCommand = s.pendingSlashInvocation.Command
		opts.ResolvedSlashArgs = s.pendingSlashInvocation.Args
		opts.ResolvedSlashSource = s.pendingSlashInvocation.Source
		utils.LogWithFields(utils.LevelInfo, "session", "send prompt applied pending slash invocation", map[string]any{"session_id": key, "reason": opts.ResolvedSlashCommand, "count": len(opts.ResolvedSlashArgs)})
		s.pendingSlashInvocation = nil
	} else if s.pendingSlashInvocation != nil {
		// resolveSlashIntoOpts already set the fields; discard the pending.
		s.pendingSlashInvocation = nil
	}
	m.applyConfigDefaults(&opts)
	resolveModelTier(&opts)

	// When the resolved model is the engine default and the session has a
	// conversation-seeded model, prefer the conversation's model. This
	// preserves the model across desktop restarts where the tab UUID changes
	// and the desktop loses its engineModelOverrides. The user can still
	// explicitly override by selecting a different model in the picker.
	if s.lastModel != "" && m.config != nil && opts.Model == m.config.DefaultModel && opts.Model != s.lastModel {
		utils.LogWithFields(utils.LevelInfo, "session", "prompt_dispatch: overriding default model with conversation model", map[string]any{"key": key, "model": opts.Model, "model_2": s.lastModel})
		opts.Model = s.lastModel
	}

	// Plan-file allocation: now that opts.Model is final, resolve the serving
	// backend for this model so the directory choice is correct. For the api
	// inner backend (and all backends using Ion's plan-mode system) the plan
	// file lives in ~/.ion/plans/; for claude-code (which owns the plan-file
	// write location) it lives under the project working directory.
	if s.planMode && s.planFilePath == "" {
		// Try to restore a persisted plan file path from the client
		// (desktop sends this from tab state after restarts). Only used
		// when the file still exists on disk; otherwise fall through to
		// fresh allocation.
		if overrides != nil && overrides.PlanFilePath != "" {
			if _, err := os.Stat(overrides.PlanFilePath); err == nil {
				s.planFilePath = overrides.PlanFilePath
				utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "sendprompt: restored from client", map[string]any{"session_id": key, "plan_file_path": s.planFilePath})
			} else {
				utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "sendprompt: client not on disk, allocating new", map[string]any{"session_id": key, "plan_file_path": overrides.PlanFilePath})
				s.planFilePath = allocateNewPlanFilePath(m.resolvedBackend(opts.Model).Capabilities(), s.config.WorkingDirectory)
				utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "sendprompt: allocated new", map[string]any{"key": key, "plan_file_path": s.planFilePath})
			}
		} else {
			// Plan file allocation is centralised in allocateNewPlanFilePath
			// (plan_slug.go). That helper keys the directory on
			// caps.PlanFileProjectScoped, which is true only for claude-code.
			// See its doc comment for the directory selection rules.
			s.planFilePath = allocateNewPlanFilePath(m.resolvedBackend(opts.Model).Capabilities(), s.config.WorkingDirectory)
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "sendprompt: allocated new", map[string]any{"key": key, "plan_file_path": s.planFilePath})
		}
		// buildRunOptions snapshotted planFilePath before allocation; backfill.
		opts.PlanFilePath = s.planFilePath
	}

	// Detect plan mode reentry: plan mode is active, we already have a plan
	// file path (preserved from a previous exit), and the session previously
	// exited plan mode via ExitPlanMode.
	planModeReentry := s.planMode && s.planFilePath != "" && s.hasExitedPlanMode
	if planModeReentry {
		opts.PlanModeReentry = true
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "reentry detected", map[string]any{"key": key, "plan_file_path": s.planFilePath})
	}

	// Capability gate: the model is final here, so resolve the serving
	// backend's static descriptor and decline unsupported feature requests
	// BEFORE any dispatch work — a typed engine_capability_unsupported event,
	// no run, no crash-shaped exit. This is the single choke point for
	// feature gating (it replaced the per-backend static reject that lived in
	// acp_backend.StartRun); the engine reports and the harness decides
	// (reroute / abort / notify) — no engine-side auto-reroute. The session
	// stays idle and immediately usable for the next prompt.
	caps := m.resolvedBackend(opts.Model).Capabilities()
	if opts.PlanMode && !caps.PlanMode {
		s.requestID = ""
		m.unbindRunLocked(requestID)
		m.mu.Unlock()
		reason := fmt.Sprintf("plan mode is not supported on the %s backend", caps.Kind)
		utils.LogWithFields(utils.LevelWarn, "session", "prompt_dispatch: capability gate declined prompt", map[string]any{
			"key": key, "model": opts.Model, "backend": caps.Kind, "capability": "plan_mode",
		})
		m.emit(key, types.EngineEvent{
			Type:              "engine_capability_unsupported",
			Capability:        "plan_mode",
			CapabilityBackend: caps.Kind,
			CapabilityReason:  reason,
		})
		return nil
	}
	// Record the serving backend's descriptor for this run so handleRunExit
	// can decide whether (and under which kind) to capture the reported
	// session id as a native-session cursor (see native_session.go).
	// Written under m.mu alongside requestID.
	s.runCaps = caps
	// For a native-session (delegated-CLI) backend, stash the ORIGINAL user
	// prompt (before resolveCliContinuity bridges prior history into
	// opts.Prompt) so handleRunExit can persist this turn into Ion's
	// conversation store. Engine-owned backends persist their own turns via
	// the runloop, so they leave this empty. Reset both halves at dispatch so
	// a prior turn's text can never leak into this one.
	s.pendingCliAssistantText = ""
	if caps.ContextModel == backend.ContextModelNativeSession {
		s.pendingCliUserTurn = text
	} else {
		s.pendingCliUserTurn = ""
	}

	injectContextFiles(s, &opts)
	m.injectExtensionContext(s, key, &opts)
	injectGitContext(s, &opts)
	injectPluginContext(s, &opts)

	// Inject session memory into the system prompt so the model has context
	// from previously compacted conversation history. Only fires when memory
	// is non-empty (i.e. a prior session generated a summary).
	if s.sessionMemory != nil {
		s.sessionMemory.InjectMemoryIntoSystemPrompt(&opts)
	}

	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: releasing lock", map[string]any{"key": key, "model": opts.Model})

	// G07: Enterprise model enforcement
	if m.config != nil && m.config.Enterprise != nil {
		if !ionconfig.IsModelAllowed(opts.Model, m.config.Enterprise) {
			// Enforcement audit event (feature 0010 audit clause). Emitted while
			// s.telemetry is still in scope under the lock; nil-safe.
			if s.telemetry != nil {
				source := "allowlist"
				for _, b := range m.config.Enterprise.BlockedModels {
					if b == opts.Model {
						source = "denylist"
						break
					}
				}
				s.telemetry.Event(telemetry.EnforcementModelRejected, map[string]any{
					"subject": opts.Model,
					"source":  source,
				}, nil)
			}
			m.mu.Unlock()
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("model %q not allowed by enterprise policy", opts.Model),
			})
			return fmt.Errorf("model %q not allowed by enterprise policy", opts.Model)
		}
	}

	m.lateLoadExtensions(s, key, overrides)

	// lateLoadExtensions may have just populated s.extensionName /
	// s.extensionVersion (first prompt on a session whose extensions arrive
	// per-prompt). buildRunOptions above ran before the late load, so re-stamp
	// the identity onto opts here — otherwise the very first extension-hosted
	// run's llm.call telemetry would miss ctx.extension.
	if opts.ExtensionName == "" {
		opts.ExtensionName = s.extensionName
	}
	if opts.ExtensionVersion == "" {
		opts.ExtensionVersion = s.extensionVersion
	}

	skipExtensions := overrides != nil && overrides.NoExtensions

	extGroup := s.extGroup
	permEng := s.permEngine
	telemCollector := s.telemetry
	mcpConns := s.mcpConns
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: lock released", map[string]any{"key": key})

	// context: fork — run the resolved command's expanded body as a forked
	// sub-agent instead of inlining it into this conversation. The parent
	// conversation still records the raw invocation as the display turn (so the
	// user sees what they ran), then the child runs with its own context/token
	// budget and streams its events on the parent's stream. Returns without
	// starting an inline run on the parent.
	if opts.ResolvedSlashContext == "fork" {
		m.forkResolvedSlash(s, key, &opts)
		s.requestID = ""
		// Forked to a sub-agent — no inline run started on the parent, so
		// clear the routing binding set at dispatch.
		m.unbindRun(requestID)
		return nil
	}

	m.fireBeforeAgentStart(s, key, extGroup, skipExtensions, &opts)

	// Clear any working message left by before_agent_start hook
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	m.fireModelSelect(s, key, extGroup, skipExtensions, &opts)

	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: building backend run config", map[string]any{"key": key})

	// Build the per-run RunConfig that travels with this run on the backend.
	// Storing hooks/perm engine/external tools/agent spawner on each run --
	// rather than mutating shared state on the singleton ApiBackend --
	// guarantees that concurrent sessions cannot trample each other's
	// closures. Without this, two parallel sessions would see each other's
	// extension context, MCP tools, and agent spawn rules.
	//
	// resolvedBackend(opts.Model) collapses the hybrid case: for plain
	// ClaudeCodeBackend/ApiBackend it returns m.backend as-is; for HybridBackend
	// it returns the inner backend that will actually handle this model.
	var runCfg *backend.RunConfig
	if apiBackend, ok := m.resolvedBackend(opts.Model).(*backend.ApiBackend); ok {
		runCfg = m.buildRunConfig(s, key, requestID, apiBackend, extGroup, skipExtensions, permEng, telemCollector, mcpConns, opts.Model)
	}

	m.wirePermissionHookServer(s, key, &opts, permEng)
	m.wireDelegatedPermissions(key, &opts)
	m.wireToolServer(s, key, &opts, extGroup)
	m.wireAgentToolServer(s, key, &opts)

	// Fire before_prompt for ClaudeCodeBackend (ApiBackend wires this inside buildRunConfig).
	m.fireBeforePromptCli(s, key, extGroup, skipExtensions, &opts)

	m.mu.RLock()
	if len(s.suppressedTools) > 0 {
		opts.SuppressTools = append(opts.SuppressTools, s.suppressedTools...)
	}
	m.mu.RUnlock()

	utils.LogWithFields(utils.LevelInfo, "session", "dispatching prompt", map[string]any{"key": key, "run_id": requestID, "model": opts.Model})
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
		utils.LogWithFields(utils.LevelInfo, "session", "prompt_dispatch: clearing retained permission_denials (new prompt supersedes)", map[string]any{"key": key, "count": len(s.lastPermissionDenials)})
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

	// Thread the session's cancellation root onto the run so a
	// session-level abort (SendAbort / StopSession cancels the root)
	// cascades to this run's context. The backend derives
	// context.WithCancel(opts.ParentCtx); nil would fall back to
	// Background, so we set it unconditionally for the main session run.
	// See session_root_context.go and backend ParentCtx handling.
	opts.ParentCtx = s.rootContext()

	// Resume-vs-bridge decision for delegated-CLI backends: resume the
	// backend's native session when this session holds a still-valid cursor
	// for it (HeadEntryID == the conversation's LeafID), otherwise bridge by
	// seeding the prior conversation transcript into the prompt — otherwise
	// the CLI subprocess receives only the current prompt and the model
	// loses all context (e.g. a conversation built on the ApiBackend then
	// continued on claude-code). See native_session.go and
	// cli_history_seed.go. Runs after opts.Prompt is finalized.
	m.resolveCliContinuity(s, &opts)

	// Dispatch to backend. ApiBackend uses the per-run config built above so
	// every closure on this run sees this session's hooks/tools/perms.
	// ClaudeCodeBackend ignores runCfg and follows its own subprocess wiring.
	//
	// HybridBackend implements both StartRun and StartRunWithConfig: it
	// records the routing decision for opts.Model and forwards to the
	// inner *ApiBackend (with runCfg) or inner *ClaudeCodeBackend (without).
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
		// Value-copy all 19 PromptOverrides fields so every per-prompt flag
		// (ResolveSlash, BashAllowlistAdditionsForThisPrompt, PlanFilePath,
		// CompactEnabled, harness prose, etc.) survives the queue round-trip
		// intact. The caller may free or reuse its pointer after this returns;
		// the copy in the queue is independent.
		ovCopy := *overrides
		pp.overrides = &ovCopy
	}
	s.promptQueue = append(s.promptQueue, pp)
	utils.LogWithFields(utils.LevelInfo, "session", "prompt queued for ( in queue)", map[string]any{"key": key, "count": len(s.promptQueue)})
	return false, nil
}
