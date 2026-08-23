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
	// Settled check: a settled session rejects prompts until resumed.
	if err := m.rejectIfSettled(key, s); err != nil {
		return err
	}
	// Busy check: a run is in flight (s.requestID != "") OR an async
	// user-initiated compaction is running (s.compactInFlight). The latter
	// does not set s.requestID — its synthetic runID is unregistered in the
	// backend — so without this second condition a prompt submitted during
	// compaction would start a real run whose load-mutate-save clobbers the
	// compaction's own save. Enqueue instead; the compaction goroutine drains
	// one queued prompt when it finishes (mirroring handleRunExit). See
	// dispatchCompact and engineSession.compactInFlight.
	// Recovery claims this slot before its goroutine calls SendPrompt. User input
	// queues behind it, while the engine-authored continuation itself may enter.
	isRecoveryContinuation := overrides != nil && overrides.InjectionKind == string(types.InjectionKindRunRecovery)
	isRecoveryWake := overrides != nil && isRecoveryWakeKind(overrides.InjectionKind)
	if s.requestID != "" || s.compactInFlight || (s.recoveryInProgress && !isRecoveryContinuation && !isRecoveryWake) {
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
	// Mint this run's trace ID under the same lock hold that assigns
	// requestID, so the two identities for one run can never disagree. Scope
	// is the run because a trace is one logical transaction: every log line
	// and telemetry event emitted between here and run exit shares this ID,
	// and it is what an extension parents its own OTLP spans to. Cleared
	// wherever requestID is cleared. See engineSession.runTraceID.
	//
	// Captured into a local as well: the struct field is guarded by m.mu and
	// may be cleared by a concurrent run-exit before this frame reaches the
	// ParentCtx assignment below, but the context this run carries must keep
	// the ID it was dispatched with.
	runTraceID := utils.NewTraceID()
	s.setRunIdentity(requestID, runTraceID)
	utils.LogWithFields(utils.LevelDebug, "session", "sendprompt: minted run trace id", map[string]any{"key": key, "run_id": requestID, "trace_id": runTraceID})
	// A run is starting, so the session is no longer parked on outstanding
	// background commands. Clear any park record here — under the same lock
	// that assigns requestID — so the two can never disagree. This covers
	// every way a run can start while parked: the wake itself, a queued prompt
	// drained by handleRunExit on the park's own exit, a user prompt typed
	// while parked, or an extension injection. A stale park record would let a
	// concurrently-arriving completion claim a park that nothing is waiting on
	// and start a second concurrent run. See clearParkedStateLocked.
	clearParkedStateLocked(s, key, "run_start")
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

	// An explicit send_prompt.model controls ordinary prompts. A resolved slash
	// command with its own `model:` field overrides it below; command frontmatter
	// is command-scoped policy, while this value is conversation-scoped intent.
	hasExplicitModel := overrides != nil && overrides.Model != ""

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
			s.clearRunIdentity()
			m.unbindRunLocked(requestID)
			m.mu.Unlock()
			m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
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
		// Extension commands use ctx.sendPrompt's explicit model as their
		// command-owned selector. It follows the same tier resolution and
		// provenance rules as markdown frontmatter.
		if overrides != nil && overrides.Model != "" {
			opts.ResolvedSlashModelAlias = overrides.Model
			utils.LogWithFields(utils.LevelInfo, "session.slash", "extension command model selector applied", map[string]any{
				"session_id": key, "command": opts.ResolvedSlashCommand, "model_alias": overrides.Model,
			})
		}
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
	if s.lastModel != "" && !hasExplicitModel && opts.ResolvedSlashModelAlias == "" && m.config != nil && opts.Model == m.config.DefaultModel && opts.Model != s.lastModel {
		utils.LogWithFields(utils.LevelInfo, "session", "prompt_dispatch: overriding default model with conversation model", map[string]any{"key": key, "model": opts.Model, "conversation_model": s.lastModel})
		opts.Model = s.lastModel
	}

	finalizeSlashModelProvenance(&opts, key)

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
		s.clearRunIdentity()
		m.unbindRunLocked(requestID)
		m.mu.Unlock()
		m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
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
	s.cliRunFailedTerminal = false
	if caps.ContextModel == backend.ContextModelNativeSession {
		s.pendingCliUserTurn = text
	} else {
		s.pendingCliUserTurn = ""
	}

	// G07: Enterprise model enforcement (fast check, under initial lock).
	if m.config != nil && m.config.Enterprise != nil {
		if !ionconfig.IsModelAllowed(opts.Model, m.config.Enterprise) {
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
			s.clearRunIdentity()
			m.unbindRunLocked(requestID)
			m.mu.Unlock()
			m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("model %q not allowed by enterprise policy", opts.Model),
			})
			return fmt.Errorf("model %q not allowed by enterprise policy", opts.Model)
		}
	}

	// --- Release the manager lock BEFORE I/O-heavy inject functions. ---
	// Safety: s.config is immutable after StartSession. s.requestID is set,
	// preventing a concurrent SendPrompt for this session from reaching
	// inject phase. s.extGroup, s.sessionMemory, and s.pluginSessionMessages
	// are written only by lateLoadExtensions below (sequential in this
	// goroutine). m.config pointer is snapshotted before unlock.
	skipExtensions := overrides != nil && overrides.NoExtensions
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: lock released for off-lock inject", map[string]any{"key": key, "model": opts.Model})

	// --- Off-lock: context injection (I/O-heavy) ---
	injectContextFiles(s, &opts)
	var clientWsCtx *types.ClientWorkspaceContext
	if overrides != nil && overrides.ClientWorkspaceContext != nil {
		clientWsCtx = overrides.ClientWorkspaceContext
	} else if s.config.ClientWorkspaceContext != nil {
		clientWsCtx = s.config.ClientWorkspaceContext
	}
	workspaceContext := m.injectWorkspaceContext(s, key, &opts, clientWsCtx)
	m.injectExtensionContext(s, key, &opts, workspaceContext)
	injectGitContext(s, &opts)
	injectPluginContext(s, &opts)

	if s.sessionMemory != nil {
		s.sessionMemory.InjectMemoryIntoSystemPrompt(&opts)
	}

	// --- Off-lock: late-load extensions (manages its own locking) ---
	m.lateLoadExtensions(s, key, overrides)

	// Re-stamp extension identity (lateLoadExtensions may have populated it).
	m.mu.RLock()
	if opts.ExtensionName == "" {
		opts.ExtensionName = s.extensionName
	}
	if opts.ExtensionVersion == "" {
		opts.ExtensionVersion = s.extensionVersion
	}
	extGroup := s.extGroup
	permEng := s.permEngine
	telemCollector := s.telemetry
	m.mu.RUnlock()
	utils.LogWithFields(utils.LevelInfo, "session", "sendprompt[]: off-lock inject complete", map[string]any{"key": key})

	// Queue-mode completions become durable inputs only when a run actually
	// starts. Claim them here, after the session lock is released, then let the
	// backend append and announce them before its first provider call.
	for _, pending := range m.takePendingBackgroundCompletions(key) {
		if len(pending.Work.Items) > 0 {
			opts.PendingBackgroundWork = append(opts.PendingBackgroundWork, types.BackgroundWorkDelivery{
				Content: pending.Text, Work: pending.Work,
			})
		}
	}

	// Lazily connect MCP servers, once per session, now that the lock is
	// released (the connect is network I/O). This is the seam that replaced the
	// eager connect in StartSession: it runs on the first prompt only, so a
	// desktop rehydrating dozens of idle tabs pays nothing, and the first
	// prompt of a session that does use MCP pays one connect instead of every
	// tab paying it at launch. Must precede the s.mcpConns read below — the
	// RunConfig for THIS dispatch is built from whatever connected here.
	m.ensureMcpConnections(s, key)

	m.mu.Lock()
	mcpConns := s.mcpConns
	m.mu.Unlock()

	// context: fork — run the resolved command's expanded body as a forked
	// sub-agent instead of inlining it into this conversation. The parent
	// conversation still records the raw invocation as the display turn (so the
	// user sees what they ran), then the child runs with its own context/token
	// budget and streams its events on the parent's stream. Returns without
	// starting an inline run on the parent.
	if opts.ResolvedSlashContext == "fork" {
		m.forkResolvedSlash(s, key, &opts)
		m.mu.Lock()
		s.clearRunIdentityFor(requestID)
		m.unbindRunLocked(requestID)
		m.mu.Unlock()
		m.ReleaseDeliveryID(key, deliveryIDFromOverrides(overrides))
		// Forked to a sub-agent — no inline run started on the parent, so
		// the parent run identity and routing binding are both cleared.
		return nil
	}

	m.fireBeforeAgentStart(s, key, extGroup, skipExtensions, &opts)

	// Clear any working message left by before_agent_start hook
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	m.fireModelSelect(s, key, extGroup, skipExtensions, &opts)
	if m.config != nil && m.config.Enterprise != nil && !ionconfig.IsModelAllowed(opts.Model, m.config.Enterprise) {
		m.mu.Lock()
		s.clearRunIdentity()
		m.unbindRunLocked(requestID)
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "model_select chose model blocked by enterprise policy", map[string]any{
			"key": key, "model": opts.Model,
		})
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: fmt.Sprintf("model %q not allowed by enterprise policy", opts.Model),
		})
		return fmt.Errorf("model %q not allowed by enterprise policy", opts.Model)
	}
	refreshSlashModelProvenance(&opts, key)
	normalizeSlashThinkingForResolvedModel(&opts, overrides)

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
	// The final engine-owned capacity gate runs before recovery-journal writes
	// and backend launch. Commands use their separate dispatch path, so /compact
	// and /clear remain available when ordinary prompts are full.
	if err := m.rejectIfContextCapacityReached(s, key, requestID, opts, caps, overrides); err != nil {
		return err
	}

	m.mu.Lock()
	current, stillActive := m.sessions[key]
	if !stillActive || current != s || current.requestID != requestID {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "prompt dispatch abandoned after session changed", map[string]any{"key": key, "run_id": requestID})
		return fmt.Errorf("session %q stopped before prompt dispatch", key)
	}
	s.setCurrentModel(opts.Model)
	s.lastContextWindow = promptCtxWindow
	promptCapacity := updateContextCapacityLocked(s, opts.Model, promptCtxWindow, opts.MaxTokens)
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
	s.lastCompletionReason = ""
	lastPct := s.lastContextPct
	lastTokens := s.lastContextTokens

	// Commit the journal outside Manager.mu. A full conversation save can fsync
	// megabytes; holding the manager lock here stalls every other session.
	journalNeeded := opts.InjectionKind != string(types.InjectionKindRunRecovery) &&
		!s.recoveryInProgress && m.recoveryEnabled(&s.config)
	m.mu.Unlock()
	if journalNeeded {
		entryID, recorded := m.recordRunRecovery(s, key, requestID, opts, overrides)
		if !recorded {
			m.mu.Lock()
			if current, ok := m.sessions[key]; ok && current == s {
				current.clearRunIdentityFor(requestID)
				m.unbindRunLocked(requestID)
			}
			m.mu.Unlock()
			return fmt.Errorf("could not persist recovery journal for session %q", key)
		}
		opts.PrePersistedUserEntryID = entryID
	}
	m.mu.Lock()
	current, stillActive = m.sessions[key]
	if !stillActive || current != s || current.requestID != requestID {
		conversationID := s.conversationID
		m.mu.Unlock()
		// StopSession can delete the session while journal fsync runs. Remove
		// only this dispatch's journal so a stopped run cannot resurrect on the
		// next engine start, while a replacement journal remains intact.
		m.clearRunRecovery(conversationID, key, requestID, "dispatch_stopped_before_start")
		utils.LogWithFields(utils.LevelWarn, "session", "prompt dispatch abandoned after recovery journal commit", map[string]any{"key": key, "run_id": requestID})
		return fmt.Errorf("session %q stopped before prompt dispatch", key)
	}
	m.mu.Unlock()

	m.emit(key, types.EngineEvent{
		Type: "engine_status",
		Fields: &types.StatusFields{
			Label: key, State: "running", Model: opts.Model,
			ContextWindow:         promptCtxWindow,
			ContextPercent:        lastPct,
			ContextTokens:         lastTokens,
			ContextEffectiveLimit: promptCapacity.EffectiveLimit,
			// A status event is a COMPLETE snapshot: a consumer replaces its
			// StatusFields with this payload. Background Bash processes started
			// by an earlier run keep running across the turn boundary, so
			// omitting them here told every consumer they had vanished the
			// moment the next prompt dispatched.
			ActiveBackgroundTasks: liveBackgroundTaskStates(key),
		},
	})

	// Thread the session's cancellation root onto the run so a
	// session-level abort (SendAbort / StopSession cancels the root)
	// cascades to this run's context. The backend derives
	// context.WithCancel(opts.ParentCtx); nil would fall back to
	// Background, so we set it unconditionally for the main session run.
	// See session_root_context.go and backend ParentCtx handling.
	//
	// The run's trace ID rides on this context (the session root carries
	// session_id/conversation_id but deliberately no trace_id), so every
	// utils.LogCtx call made anywhere beneath this run — backend loop, tool
	// execution, provider streaming — stamps trace_id automatically without
	// each site having to thread it by hand.
	opts.ParentCtx = utils.WithTraceID(s.rootContext(), runTraceID)

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
	// StartRun may schedule work immediately, and callbacks acquire Manager.mu.
	// Validate ownership under the lock, then release it before launch. The run
	// identity and routing binding remain committed, so a synchronous callback
	// resolves normally instead of deadlocking on this manager.
	m.mu.Lock()
	current, stillActive = m.sessions[key]
	if !stillActive || current != s || current.requestID != requestID {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelWarn, "session", "prompt dispatch abandoned before backend start", map[string]any{"key": key, "run_id": requestID})
		return fmt.Errorf("session %q stopped before backend start", key)
	}
	launchAck := make(chan struct{})
	s.launchingRunID = requestID
	s.launchAck = launchAck
	m.mu.Unlock()
	if hybrid, ok := m.backend.(*backend.HybridBackend); ok {
		hybrid.StartRunWithConfig(requestID, opts, runCfg)
	} else if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		apiBackend.StartRunWithConfig(requestID, opts, runCfg)
	} else {
		m.backend.StartRun(requestID, opts)
	}
	m.mu.Lock()
	if current, ok := m.sessions[key]; ok && current == s && current.launchAck == launchAck {
		current.launchingRunID = ""
		current.launchAck = nil
	}
	close(launchAck)
	m.mu.Unlock()
	return nil
}
