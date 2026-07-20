package session

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// StartSessionResult carries information about the session after a StartSession call.
type StartSessionResult struct {
	Existed        bool   `json:"existed"`
	ConversationID string `json:"conversationId,omitempty"`
}

// StartSession creates a new session with the given config.
func (m *Manager) StartSession(key string, config types.EngineConfig) (*StartSessionResult, error) {
	utils.LogWithFields(utils.LevelInfo, "session", "startsession", map[string]any{"key": key, "working_directory": config.WorkingDirectory, "count": len(config.Extensions)})
	m.mu.Lock()

	if s, exists := m.sessions[key]; exists {
		convID := s.conversationID
		needsExtensions := len(config.Extensions) > 0 && (s.extGroup == nil || s.extGroup.IsEmpty())
		wantsRebind := config.SessionID != "" && config.SessionID != convID && s.requestID == ""
		m.mu.Unlock()

		// Re-register extensions when the session was restored without them
		// (e.g. daemon restart where the extension subprocess was not persisted).
		if needsExtensions {
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: re-registering extensions on existing session", map[string]any{"key": key, "count": len(config.Extensions)})
			m.loadAndWireExtensions(s, key, config)
		}

		// Rebind: the caller wants a specific conversation that differs from
		// the session's current one. This is the post-restart resume path:
		// the engine pre-minted a fresh id before the desktop asserted the
		// real conversation. If the requested conversation file exists on
		// disk and no run is in flight, rebind the session to the requested
		// conversation so the desktop stops re-driving futile resumes.
		if wantsRebind {
			if conversation.Exists(config.SessionID, "") {
				m.rebindSession(s, key, config.SessionID)
				utils.LogWithFields(utils.LevelInfo, "session", "startsession: rebound to requested conversation", map[string]any{"key": key, "conversation_id": config.SessionID, "was": convID})
				return &StartSessionResult{Existed: true, ConversationID: config.SessionID}, nil
			}
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: caller requested conversation has no backing file, keeping current", map[string]any{"key": key, "requested": config.SessionID, "keeping": convID})
		}

		utils.LogWithFields(utils.LevelInfo, "session", "startsession: already exists (idempotent)", map[string]any{"key": key, "conversation_id": convID})
		return &StartSessionResult{Existed: true, ConversationID: convID}, nil
	}

	// Resolve the conversation ID for this session. When the caller supplies an
	// explicit SessionID it wins; otherwise the binding store and the
	// ForceNewConversation flag decide between resume and fresh-mint. See
	// resolveConversationID in session_bindings.go for the full decision tree
	// and logging. The backend's loadOrCreateConversation handles a pre-set id:
	// it tries Load, gets ErrNotFound (no file yet), and calls CreateConversation
	// with this ID — so the conversation file will use this same ID. (#230/#231)
	convID := resolveConversationID(bindingsPath(), key, config)

	// Whether the resolved conversation already has a backing file. A genuine
	// resume (file present) gets its binding written immediately below for
	// restart resilience; a freshly pre-minted id (no file) DEFERS the binding
	// until the conversation is first saved, so a started-but-never-saved
	// session never leaves a phantom binding. (#230/#231)
	convExists := conversation.Exists(convID, "")

	s := &engineSession{
		key:              key,
		config:           config,
		conversationID:   convID,
		bindingPending:   !convExists,
		agents:           agents.NewRegistry(),
		childPIDs:        make(map[int]struct{}),
		pending:          pending.New(),
		maxQueueDepth:    32,
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		resourceBroker:   resource.NewBroker(),
	}

	// Initialize the session's cancellation root before any run or
	// dispatch can be launched. Every cancellable operation spawned for
	// this session derives from this root, so SendAbort / StopSession can
	// cancel the whole in-flight tree in one call. See
	// session_root_context.go.
	s.newSessionRootContext()

	// Initialize process registry for extension-spawned subprocesses.
	// If the PID-file directory cannot be created, log and continue with a
	// nil registry — downstream call sites (extcontext.go) already guard
	// with `if reg := sa.ProcRegistry(); reg != nil`, so extensions that
	// would have used it degrade to no-op instead of silently failing.
	home, _ := os.UserHomeDir()
	pidsDir := filepath.Join(home, ".ion", "agent-pids")
	if reg, err := extension.NewProcessRegistry(pidsDir); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "startsession : process registry unavailable", map[string]any{"key": key, "error": err})
		s.procRegistry = nil
	} else {
		s.procRegistry = reg
	}

	// Wire permissions from config (default allow-all when no policy configured)
	if m.config != nil && m.config.Permissions != nil {
		s.permEngine = permissions.NewEngine(m.config.Permissions)
	} else {
		s.permEngine = permissions.NewEngine(&permissions.DefaultPolicy)
	}
	// G01: Wire LLM classifier for "ask" mode
	if s.permEngine != nil && m.config != nil && m.config.Permissions != nil && m.config.Permissions.Mode == "ask" {
		s.permEngine.SetClassifier(permissions.NewLlmClassifier(""))
	}

	// Wire telemetry from config
	if m.config != nil && m.config.Telemetry != nil && m.config.Telemetry.Enabled {
		s.telemetry = telemetry.NewCollector(*m.config.Telemetry)
	}

	// Wire the permission-decision telemetry seam. The audit callback fires on
	// every permission Check and emits a permission.decision telemetry event
	// (nil-safe: no-op when telemetry is disabled). Wired after both the
	// permission engine and telemetry collector are constructed above.
	m.wirePermissionDecisionTelemetry(s)

	m.sessions[key] = s

	m.mu.Unlock()

	// Persist the key->conversationId binding for restart resilience (B2 fix
	// for issue #230) ONLY for a genuine resume — a conversation whose file
	// already exists on disk. For a freshly pre-minted id (no file yet) the
	// binding is DEFERRED until the conversation is first saved (flushed in
	// handleRunExit). This prevents a started-but-never-saved session from
	// leaving a "phantom" binding that a later restart would resume into an
	// empty conversation — the failure mode that orphaned real history across
	// the desktop restart. (#230/#231)
	if !s.bindingPending {
		saveBinding(bindingsPath(), key, convID)
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "startsession: deferring binding for pre-minted until first save", map[string]any{"key": key, "run_id": convID})
	}

	// Rehydrate agent dispatch state from the conversation file if the
	// session is resuming an existing conversation. This runs before
	// extensions fire session_start so the agent registry is pre-populated
	// with completed dispatches. When the extension later emits its fresh
	// roster, MergedSnapshot deduplicates: engine-managed entries (with
	// task, conversationId, elapsed) win over the extension's idle entries.
	if s.conversationID != "" {
		// rehydrateDispatchState loads and parses the conversation file once and
		// returns it, so the model/context-usage seeding below reuses the same
		// *Conversation instead of re-reading and re-parsing from disk. A resumed
		// startup restores many tabs at once; a redundant second full load per
		// tab (plus a partial header read) dominated startup parse time.
		conv := m.rehydrateDispatchState(s, key)

		// Restore the persisted per-provider native-session cursors so a
		// resumed conversation keeps its delegated-CLI continuity across the
		// restart: a still-valid cursor lets the next same-provider turn
		// resume natively instead of re-bridging the whole transcript.
		m.rehydrateNativeSessions(s, conv)

		// Seed lastModel from the conversation so ReconcileState emits the
		// correct model before any prompt dispatches. Without this, a resumed
		// session emits model="" on reconcile, causing the desktop to fall back
		// to its preference default (which may differ from the conversation's
		// actual model). This also seeds lastContextWindow so the context-percent
		// denominator is correct from the first status.
		if conv != nil && conv.Model != "" {
			convModel := conv.Model
			ctxWindow := conversation.DefaultContext
			if info := providers.GetModelInfo(convModel); info != nil {
				ctxWindow = info.ContextWindow
			}
			// Seed lastContextPct from the persisted conversation so the initial
			// idle engine_status reports the true usage instead of 0%. Without
			// this a resumed conversation shows an empty context bar until the
			// first prompt's usage event lands. Computed against the already-loaded
			// conv and the resolved context window.
			seededPct := 0
			usage := conversation.GetContextUsage(conv, ctxWindow)
			if usage.Percent > 0 {
				seededPct = usage.Percent
			}
			m.mu.Lock()
			s.lastModel = convModel
			s.lastContextWindow = ctxWindow
			if seededPct > 0 {
				s.lastContextPct = seededPct
			}
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: seeded from", map[string]any{"key": key, "model": convModel, "ctx_window": ctxWindow, "seeded_pct": seededPct, "run_id": s.conversationID})
		} else {
			utils.LogWithFields(utils.LevelDebug, "session", "startsession: no conversation model to seed", map[string]any{"key": key, "run_id": s.conversationID})
		}

		// Initialize session memory for resumed conversations. The memory
		// file (if it exists) is loaded from disk so the first compaction
		// on this session can use the pre-existing summary as a zero-cost
		// context restoration source. The memory updater starts via
		// Start() and will be stopped by StopSession.
		memoryDisabled := m.config != nil && m.config.Compaction != nil &&
			m.config.Compaction.MemoryEnabled != nil && !*m.config.Compaction.MemoryEnabled
		if !memoryDisabled {
			convDir := conversation.DefaultConversationsDir()
			sm := NewSessionMemory(s.conversationID, convDir, nil)
			if sm.LoadMemory() {
				utils.LogWithFields(utils.LevelInfo, "session", "startsession: loaded session memory for", map[string]any{"key": key, "run_id": s.conversationID})
			}
			sm.Start()
			m.mu.Lock()
			s.sessionMemory = sm
			m.mu.Unlock()
		} else {
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: session memory disabled by config", map[string]any{"key": key})
		}
	}

	// Signal that session startup is in progress so consumers can mirror
	// loading state. Events flow through the socket broadcast independently
	// of the request-response ACK, so consumers receive these before
	// StartSession returns.
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "starting"},
	})

	// Load extensions if configured (outside lock -- subprocess may block)
	if len(config.Extensions) > 0 {
		m.loadAndWireExtensions(s, key, config)
	}

	// Load skills from default paths
	skillPaths := skills.IonSkillPaths()
	for _, dir := range []string{skillPaths.User, skillPaths.Project} {
		loaded, err := skills.LoadSkillDirectory(dir, nil)
		if err == nil {
			for _, sk := range loaded {
				skills.RegisterSkill(sk)
			}
		}
	}
	// Load Claude Code–style skills from ~/.claude/skills (one subdir per
	// skill, each with a SKILL.md file). Only attempted when the ClaudeCompat
	// flag is set on the engine config. A missing directory is a silent no-op
	// (returns nil, nil).
	if config.ClaudeCompat {
		if claudeSkills, err := skills.LoadClaudeSkillsDirectory(skillPaths.ClaudeUser); err == nil {
			for _, sk := range claudeSkills {
				skills.RegisterSkill(sk)
			}
		}
	} else {
		utils.Debug("Session", "skipping ~/.claude/skills/ (claudeCompat not set)")
	}
	if names := skills.ListSkillNames(); len(names) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "loaded skills", map[string]any{"count": len(names), "model": names})
		// Refresh the Skill tool's description so the model's tool manifest
		// lists the available skills (with their when_to_use hints). This
		// must run after all skills are registered; RefreshSkillToolDescription
		// re-registers the Skill tool with a freshly-built manifest.
		tools.RefreshSkillToolDescription()
	}

	// Load and wire Claude Code-compatible plugins (SessionStart hooks + UserPromptSubmit hooks).
	m.loadAndWirePlugins(s, key)

	// Connect MCP servers from config (outside lock)
	if m.config != nil && len(m.config.McpServers) > 0 {
		m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: "Connecting MCP servers...",
		})
		for name, mcpCfg := range m.config.McpServers {
			conn, err := mcp.Connect(name, mcpCfg)
			if err != nil {
				utils.LogWithFields(utils.LevelInfo, "session", "mcp connect failed", map[string]any{"model": name, "error": err})
				continue
			}
			m.mu.Lock()
			// Guard against session disposal/replacement while Connect() was
			// blocking. If the session is gone or has been replaced, close the
			// freshly-opened connection immediately to avoid a file-descriptor
			// leak.
			if cur, ok := m.sessions[key]; !ok || cur != s {
				m.mu.Unlock()
				_ = conn.Close()
				utils.LogWithFields(utils.LevelInfo, "session", "mcp : session disposed during connect — closing leaked conn", map[string]any{"model": name, "key": key})
				continue
			}
			s.mcpConns = append(s.mcpConns, conn)
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "mcp server connected ( tools)", map[string]any{"model": name, "count": len(conn.Tools())})
		}
	}

	m.emit(key, types.EngineEvent{
		Type:         "engine_working_message",
		EventMessage: "",
	})
	// Emit the initial idle status through emitStatusSnapshot so the payload
	// carries the seeded contextPercent / contextWindow / model rather than
	// hardcoded zeros. On a resumed conversation lastContextPct is seeded above
	// from the conversation file, so the desktop binds the correct usage from
	// the first status rather than showing 0% until the first prompt.
	m.emitStatusSnapshot(key, "start_session")

	return &StartSessionResult{Existed: false, ConversationID: s.conversationID}, nil
}

// rebindSession changes an idle session's conversation identity to a different
// (existing) conversation. Used when the desktop restarts and asserts the real
// conversation ID on a session that was pre-minted before the client connected.
// The caller must verify: (a) the target conversation file exists on disk,
// (b) no run is in flight (s.requestID == ""). (#270)
func (m *Manager) rebindSession(s *engineSession, key, newConvID string) {
	m.mu.Lock()
	oldConvID := s.conversationID
	s.conversationID = newConvID
	s.bindingPending = false
	m.mu.Unlock()

	saveBinding(bindingsPath(), key, newConvID)

	// Re-seed model and context usage from the target conversation so the
	// next status snapshot carries correct values.
	if convModel, err := conversation.LoadLlmHeaderModel(newConvID, ""); err == nil && convModel != "" {
		ctxWindow := conversation.DefaultContext
		if info := providers.GetModelInfo(convModel); info != nil {
			ctxWindow = info.ContextWindow
		}
		seededPct := 0
		if conv, lerr := conversation.Load(newConvID, ""); lerr == nil {
			usage := conversation.GetContextUsage(conv, ctxWindow)
			if usage.Percent > 0 {
				seededPct = usage.Percent
			}
		}
		m.mu.Lock()
		s.lastModel = convModel
		s.lastContextWindow = ctxWindow
		if seededPct > 0 {
			s.lastContextPct = seededPct
		}
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session", "rebindsession: seeded model and context from target conversation", map[string]any{"key": key, "model": convModel, "context_window": ctxWindow, "context_pct": seededPct, "conversation_id": newConvID, "was": oldConvID})
	}

	m.emitStatusSnapshot(key, "rebind")
}

// loadAndWireExtensions loads extension subprocesses, wires their hooks and
// callbacks, and fires session_start. Safe to call on both new and existing
// sessions — the caller must ensure the session does not already have a
// loaded extension group.
func (m *Manager) loadAndWireExtensions(s *engineSession, key string, config types.EngineConfig) {
	extPaths := config.Extensions
	group := extension.NewExtensionGroup()
	for _, extPath := range extPaths {
		m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: fmt.Sprintf("Loading extension: %s", filepath.Base(filepath.Dir(extPath))),
		})
		host := extension.NewHost()
		if m.config != nil && m.config.Timeouts != nil {
			host.SetRPCTimeout(m.config.Timeouts.ExtensionRpc())
		}

		// Enterprise required hooks prepended before extension loads
		if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.RequiredHooks) > 0 {
			hooks := make([]struct{ Event, Handler string }, len(m.config.Enterprise.RequiredHooks))
			for i, h := range m.config.Enterprise.RequiredHooks {
				hooks[i] = struct{ Event, Handler string }{Event: h.Event, Handler: h.Handler}
			}
			host.RegisterRequiredHooks(hooks)
		}

		extCfg := &extension.ExtensionConfig{
			ExtensionDir:     filepath.Dir(extPath),
			WorkingDirectory: config.WorkingDirectory,
		}
		if err := host.Load(extPath, extCfg); err != nil {
			stderrTail := host.StderrTail()
			utils.LogWithFields(utils.LevelError, "session", "extension load failed", map[string]any{"ext_path": extPath, "error": err.Error()})
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension load failed: %s", err.Error()),
				ErrorCode:    "extension_load_failed",
				StderrTail:   stderrTail,
			})
			continue
		}
		// extension.coldstart telemetry (family 4e): the host is up and its init
		// handshake completed. Nil-safe on the session collector.
		m.emitExtensionColdstartTelemetry(s, key, host, extPath)
		capturedKey := key
		host.SetOnDeath(func(h *extension.Host) {
			m.handleHostDeath(capturedKey, h)
		})
		// Wire async-trigger lifecycle (D-010 / D-011) BEFORE
		// committing any init-time webhook/schedule declarations so
		// the registry's veto pipeline fires through the SDK with a
		// real session context.
		m.wireHostAsync(key, host)
		m.commitHostInitAsyncDecls(key, host)
		// Commit resource declarations (D-007) onto the session broker.
		if errs := host.CommitPendingResourceDecls(s.resourceBroker); len(errs) != 0 {
			for _, err := range errs {
				m.emit(key, types.EngineEvent{
					Type:         "engine_error",
					EventMessage: fmt.Sprintf("resource declaration rejected: %v", err),
					ErrorCode:    "resource_init_rejected",
				})
			}
		}
		group.Add(host)
	}
	if group.IsEmpty() {
		return
	}

	// Capture extension identity from the loaded hosts. Both fields are final
	// by the time Load() returns: Version comes from extension.json (build-time
	// constant), and Name resolves manifest → init-handshake → directory
	// basename (host_lifecycle.go / parseInitResult). Populating the name here
	// is what makes telemetry attribution (run.complete / llm.call
	// ctx.extension) work in a real session: the engine_status broadcast path
	// below (SetPersistentEmit handler) only fires for emissions made OUTSIDE
	// a hook context — ext/emit prefers the active hook ctx.Emit
	// (host_rpc.go), which bypasses that handler — so extensions that
	// broadcast their name from inside session_start/before_prompt hooks
	// (the normal case) would otherwise never populate s.extensionName.
	// The broadcast handler remains as a friendly-name override for
	// persistent-context emissions.
	m.mu.Lock()
	for _, h := range group.Hosts() {
		if s.extensionName == "" && h.Name() != "" {
			s.extensionName = h.Name()
		}
		if s.extensionVersion == "" && h.Version() != "" {
			s.extensionVersion = h.Version()
		}
	}
	m.mu.Unlock()

	// Wire send_message and persistent emit on each host
	for _, host := range group.Hosts() {
		capturedKey := key
		// Bind session/conversation IDs so extension log notifications are
		// stamped with the correlating IDs (unified log schema).
		host.BindSession(s.key, s.conversationID)
		host.SetOnSendMessage(func(payload extension.SendPromptPayload) {
			// Shared dispatch body (prompt_options.go) so the active-hook path
			// and this fallback path produce identical run configuration.
			// Model + bash-allowlist additions flow through; nothing is dropped.
			go m.dispatchSendPromptPayload(capturedKey, "start_session", payload)
		})
		// Wire the per-handler hook_latency telemetry sink. The collector's
		// Event signature matches SetTelemetrySink exactly; when the session has
		// no collector the sink stays nil and callHook emits nothing.
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

		// Persistent publish for ext/publish_resource calls from
		// onComplete callbacks (after the run exits, ctxStack is empty).
		// Always publish to session broker first, then fan out to global
		// broker for reliable delivery (per-session subscriptions often
		// fail because the producer only exists on one session's broker).
		host.SetPersistentPublishResource(func(kind string, delta types.ResourceDelta) error {
			if s.resourceBroker != nil {
				if err := s.resourceBroker.Publish(kind, delta); err != nil {
					return err
				}
			} else {
				return fmt.Errorf("no broker available")
			}
			if m.globalBroker != nil {
				m.globalBroker.PublishDirect(kind, delta)
			}
			return nil
		})

		// Persistent recall for ext/recall_agent when the parent run is idle.
		// The dispatch registry outlives runs; wiring it here lets a watchdog
		// timeout (fired by the extension after dispatch-and-go-idle) still
		// cancel the background agent even when no run is active on this session.
		host.SetPersistentRecall(func(name, reason string) (bool, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return false, fmt.Errorf("dispatch registry not available")
			}
			found := reg.Recall(name, reason)
			return found, nil
		})

		// Persistent steer for ext/steer_dispatch when the parent run is idle.
		host.SetPersistentSteer(func(dispatchID, message string) (extension.SteerDispatchResult, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return extension.SteerDispatchResult{Outcome: "not_found"}, fmt.Errorf("dispatch registry not available")
			}
			outcome := reg.SteerByID(dispatchID, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == extcontext.SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		})

		// Persistent name-based steer for ext/steer_dispatch_by_name when the parent run is idle.
		host.SetPersistentSteerByName(func(name, message string) (extension.SteerDispatchResult, error) {
			reg := s.dispatchRegistry
			if reg == nil {
				return extension.SteerDispatchResult{Outcome: "not_found"}, fmt.Errorf("dispatch registry not available")
			}
			outcome := reg.SteerByName(name, message)
			return extension.SteerDispatchResult{
				Delivered: outcome == extcontext.SteerOutcomeDelivered,
				Outcome:   string(outcome),
			}, nil
		})
	}

	m.mu.Lock()
	s.extGroup = group
	m.mu.Unlock()

	// Fire session_start
	m.emit(key, types.EngineEvent{
		Type:         "engine_working_message",
		EventMessage: "Initializing extensions...",
	})
	ctx := m.newExtContext(s, key)
	_ = group.FireSessionStart(ctx)

	// Start the workspace filesystem watcher after extensions are loaded and
	// session_start has fired. Wiring after session_start lets extensions
	// observe the very first batch of events without a startup-race; the
	// watcher's own startup walk does not synthesize events for pre-existing
	// files, so consumers see only post-start activity.
	if release := m.startWorkspaceWatcher(s, key, group); release != nil {
		m.mu.Lock()
		s.fsWatcherRelease = release
		m.mu.Unlock()
	}

	// Discover capabilities from extensions
	caps := group.FireCapabilityDiscover(ctx)
	for _, cap := range caps {
		for _, host := range group.Hosts() {
			host.SDK().RegisterCapability(cap)
		}
	}

	// Phase 0.5: publish the initial command-registry snapshot, then wire
	// per-host onCommandsChange observers so subsequent mid-session
	// RegisterCommand calls also trigger snapshots.
	//
	// Ordering matters: by emitting the initial snapshot FIRST and wiring
	// observers SECOND, we collapse all init-time RegisterCommand calls
	// (which fire during host.Load() and during FireSessionStart) into a
	// single snapshot event rather than N events with intermediate states.
	// Mid-session registrations after this point each get their own
	// snapshot, which is the desired behavior — a consumer's cached view
	// only needs to be re-warmed for changes that happen after init
	// settles.
	m.emitCommandRegistry(key)
	for _, host := range group.Hosts() {
		capturedKey := key
		host.SetOnCommandsChange(func() {
			m.emitCommandRegistry(capturedKey)
		})
	}
	utils.LogWithFields(utils.LevelInfo, "session", "loadandwireextensions: wired oncommandschange observers for", map[string]any{"count": len(group.Hosts()), "key": key})
}
