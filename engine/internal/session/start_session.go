package session

import (
	"fmt"
	"path/filepath"
	"time"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/resource"
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
	// StorageRoot is the absolute directory this session's conversation is
	// (or would be) stored under, when principal partitioning is enabled
	// and the session carries a principal. Empty when partitioning is off
	// or the session is unattributed -- the caller (e.g. a harness deriving
	// its own per-principal data root, see cos2's journalroot.go) falls
	// back to its historical behavior in that case.
	StorageRoot string `json:"storageRoot,omitempty"`
}

// startSession owns the common initialization path. A fork supplies its
// reservation and inherited state so the target becomes visible atomically and
// session_start hooks observe the inherited state from their first instruction.
// principal is the manifest C1/C2 attribution for this session; nil when the
// caller supplied none (pre-existing behavior, unchanged).
func (m *Manager) startSession(
	key string,
	config types.EngineConfig,
	principal *types.SessionPrincipal,
	reservation *forkReservation,
	initial *forkInitialState,
) (*StartSessionResult, error) {
	if reservation != nil {
		defer func() { m.releaseForkKey(key, reservation) }()
	}
	var err error
	config, err = ionconfig.ApplyNewConversationDefaults(config, principal)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session", "startsession rejected by locked profile policy", map[string]any{"key": key, "working_directory": config.WorkingDirectory, "error": err.Error()})
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, "session", "startsession", map[string]any{"key": key, "working_directory": config.WorkingDirectory, "count": len(config.Extensions)})
	// Existing sessions only need filesystem preflight when they must restore
	// their missing extension hosts. A normal idempotent start must not depend
	// on a path that is no longer available after its host is already loaded.
	m.mu.RLock()
	existing, exists := m.sessions[key]
	needsPreflight := !exists || (len(config.Extensions) > 0 && (existing.extGroup == nil || existing.extGroup.IsEmpty()))
	m.mu.RUnlock()
	plans := []extension.ResolvedExtensionPlan(nil)
	policy := identityPolicy{requirement: identityOptional}
	if needsPreflight {
		plans, policy, err = m.preflightIdentityPolicy(key, config)
		if err != nil {
			return nil, err
		}
	}
	m.mu.Lock()

	if reservation == nil {
		if reservedBy, reserved := m.forkReservations[key]; reserved {
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelWarn, "session", "startsession: key reserved by fork", map[string]any{
				"key": key, "source_key": reservedBy.sourceKey,
			})
			return nil, sessionKeyExistsError(key)
		}
	} else if m.forkReservations[key] != reservation {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelError, "session.fork", "fork session: reservation lost before startup", map[string]any{
			"source_key": reservation.sourceKey, "new_key": key,
		})
		return nil, fmt.Errorf("fork reservation for session %q was lost", key)
	}

	if s, exists := m.sessions[key]; exists {
		convID := s.conversationID
		needsExtensions := len(config.Extensions) > 0 && (s.extGroup == nil || s.extGroup.IsEmpty())
		wantsRebind := config.SessionID != "" && config.SessionID != convID && s.requestID == ""
		// An idempotent start_session carries the owning client's LATEST
		// tool-gate declaration (client tools included). Adopt it wholesale:
		// a reconnecting/upgraded desktop re-asserts its tool set this way.
		// Runs capture their runtime at dispatch (buildClientToolRuntime),
		// so an in-flight run's tools are untouched; the NEXT run sees the
		// new declaration. A nil incoming ToolGate means the caller declares
		// no gating and clears any prior declaration — same replace-not-merge
		// semantics as the rest of the config on a fresh start.
		toolGateChanged := (s.config.ToolGate != nil) != (config.ToolGate != nil)
		if !toolGateChanged && config.ToolGate != nil {
			toolGateChanged = len(s.config.ToolGate.ClientTools) != len(config.ToolGate.ClientTools)
		}
		s.config.ToolGate = config.ToolGate
		// A reconnecting client's re-assert of start_session carries its
		// latest principal, same replace-not-merge convention as ToolGate
		// above -- but only forward: a nil principal on this call never
		// clears one the session already carries (an older client that
		// predates this field, or the engine's own idempotent internal
		// callers, must not silently un-attribute a session).
		principalChanged := principal != nil && (s.principal == nil || s.principal.Subject != principal.Subject)
		if principal != nil {
			s.principal = principal
			promoteSessionPrincipalProcessWide(principal)
		}
		if principalChanged {
			// Permission policy follows the account the session acts as.
			m.wireSessionPermissions(s, principal)
			m.wirePermissionDecisionTelemetry(s)
		}
		m.mu.Unlock()
		if toolGateChanged {
			utils.LogWithFields(utils.LevelInfo, "session.toolgate", "startsession: tool-gate declaration replaced on existing session", map[string]any{
				"key": key, "declared": config.ToolGate != nil,
			})
		}
		if principalChanged {
			utils.LogWithFields(utils.LevelInfo, "session", "session principal set", map[string]any{"session_key": key, "principal_subject": principal.Subject, "provider": principal.Provider, "kind": principal.Kind})
			m.fireIdentityChangedForSession(key, principal)
		}

		// Re-register extensions when the session was restored without them
		// (e.g. daemon restart where the extension subprocess was not persisted).
		if needsExtensions {
			utils.LogWithFields(utils.LevelInfo, "session.identity", "restored session extension preflight accepted", map[string]any{"key": key, "requirement": policy.requirement, "count": len(plans)})
			s.identityPolicy = policy
			m.loadAndWireExtensions(s, key, config, plans)
		}

		// Rebind: the caller wants a specific conversation that differs from
		// the session's current one. This is the post-restart resume path:
		// the engine pre-minted a fresh id before the desktop asserted the
		// real conversation. If the requested conversation file exists on
		// disk and no run is in flight, rebind the session to the requested
		// conversation so the desktop stops re-driving futile resumes.
		if wantsRebind {
			if conversation.Exists(config.SessionID, "") {
				if err := checkConversationAccess(principal, config.SessionID, false); err != nil {
					utils.LogWithFields(utils.LevelWarn, "session", "startsession: rebind refused by principal guard", map[string]any{"key": key, "conversation_id": config.SessionID})
					return nil, err
				}
				m.rebindSession(s, key, config.SessionID)
				utils.LogWithFields(utils.LevelInfo, "session", "startsession: rebound to requested conversation", map[string]any{"key": key, "conversation_id": config.SessionID, "was": convID})
				return &StartSessionResult{Existed: true, ConversationID: config.SessionID, StorageRoot: storageRootFor(s.principal)}, nil
			}
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: caller requested conversation has no backing file, keeping current", map[string]any{"key": key, "requested": config.SessionID, "keeping": convID})
		}

		utils.LogWithFields(utils.LevelInfo, "session", "startsession: already exists (idempotent)", map[string]any{"key": key, "conversation_id": convID})
		return &StartSessionResult{Existed: true, ConversationID: convID, StorageRoot: storageRootFor(s.principal)}, nil
	}

	// D-007: enterprise session cap. Checked after the idempotency branch so
	// re-asserting an EXISTING session (the desktop's restart-restore path)
	// never trips the limit — only genuinely new session creation counts
	// against the ceiling. The merged config's ResourceLimits already carries
	// the enterprise seal (EnforceEnterprise caps user values), so a single
	// read here enforces policy for every client on the socket.
	if m.config != nil && m.config.ResourceLimits != nil && m.config.ResourceLimits.MaxSessions != nil {
		limit := *m.config.ResourceLimits.MaxSessions
		if len(m.sessions) >= limit {
			procTelem := m.procTelemetry
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: rejected by session limit", map[string]any{"key": key, "active": len(m.sessions), "limit": limit})
			// Enforcement audit event (feature 0010 audit clause). Emitted via
			// the process-level collector because no per-session collector
			// exists at rejection time. Nil-safe.
			if procTelem != nil {
				procTelem.Event(telemetry.EnforcementSessionLimit, map[string]any{
					"subject": key,
					"source":  "limit",
					"limit":   limit,
				}, nil)
			}
			return nil, fmt.Errorf("session limit reached: enterprise policy allows a maximum of %d concurrent sessions", limit)
		}
		utils.LogWithFields(utils.LevelDebug, "session", "startsession: session limit check passed", map[string]any{"key": key, "active": len(m.sessions), "limit": limit})
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

	// FR-01: a new session key resolving to an EXISTING conversation is a
	// resume/attach, same class of access as the rebind branch above --
	// guard it identically. A fresh mint (convExists==false) has nothing to
	// own yet, so checkConversationAccess is a no-op there.
	if convExists {
		if err := checkConversationAccess(principal, convID, false); err != nil {
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelWarn, "session", "startsession: refused by principal guard", map[string]any{"key": key, "conversation_id": convID})
			return nil, err
		}
	}

	s := &engineSession{
		key:              key,
		config:           config,
		identityPolicy:   policy,
		conversationID:   convID,
		bindingPending:   !convExists,
		agents:           m.newAgentRegistry(principal),
		agentEmitter:     &agentEmitter{},
		childPIDs:        make(map[int]struct{}),
		pending:          pending.New(),
		maxQueueDepth:    32,
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		resourceBroker:   resource.NewBroker(),
		principal:        principal,
	}
	var dispatchHistory *types.DispatchHistoryConfig
	if m.config != nil {
		dispatchHistory = m.config.DispatchHistory
	}
	s.dispatchRegistry.SetHistoryLimits(dispatchHistory)
	m.wireDispatchRegistryObservers(s, key)
	m.watchWorkspaceProducers(key, s.resourceBroker)
	if initial != nil {
		s.planMode = initial.planMode
		s.planModeTools = append([]string(nil), initial.planModeTools...)
		s.planModeAllowedBashCommands = append([]string(nil), initial.planModeAllowedBashCommands...)
		s.planModeAllowedMcpTools = append([]string(nil), initial.planModeAllowedMcpTools...)
		s.planFilePath = initial.planFilePath
		s.hasExitedPlanMode = initial.hasExitedPlanMode
	}
	s.rootDispatchCompletions = loadRootDispatchOutbox(convID)
	if len(s.rootDispatchCompletions) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session.dispatch_delivery", "root dispatch outbox rehydrated", map[string]any{"session_id": key, "conversation_id": convID, "count": len(s.rootDispatchCompletions)})
	}
	if principal != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "session principal set", map[string]any{"session_key": key, "principal_subject": principal.Subject, "provider": principal.Provider, "kind": principal.Kind})
		promoteSessionPrincipalProcessWide(principal)
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
	pidsDir := filepath.Join(utils.IonDir(), "agent-pids")
	if reg, err := extension.NewProcessRegistry(pidsDir); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "startsession : process registry unavailable", map[string]any{"key": key, "error": err})
		s.procRegistry = nil
	} else {
		s.procRegistry = reg
	}

	// Wire permissions from the config that applies to this session's account.
	m.wireSessionPermissions(s, principal)

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
	if reservation != nil {
		delete(m.forkReservations, key)
	}

	m.mu.Unlock()

	// conversation.* telemetry (issue #378, child 04): conversation.lifecycle
	// fires "resumed" here, immediately, because convExists==true already
	// proves durable existence (conversation.Exists checked the file above at
	// line ~173) — no save confirmation is needed for a resume. The mirror
	// case, "created", cannot fire here: convExists==false means no file
	// exists yet, so creation is not yet durable. That case fires later, from
	// flushPendingBinding, once the deferred binding write confirms the first
	// successful save (see its doc comment). This whole block only runs for a
	// GENUINELY NEW session object (the idempotent "already exists" branch
	// above returns earlier without touching either action).
	if convExists {
		ctx := conversationCorrelationCtx(key, convID, "", "", "", "")
		m.conversationEmitter().Lifecycle(ctx, convID, telemetry.ActionResumed, "")
	}

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
		utils.LogWithFields(utils.LevelInfo, "session", "startsession: deferring binding for pre-minted until first save", map[string]any{"key": key, "conversation_id": convID})
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
		// Rebuild the registry's terminal dispatch history from the same
		// records, so a restarted session still answers what finished.
		s.dispatchRegistry.SeedHistory(dispatchHistoryFromConversation(conv, time.Now()))

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
		//
		// The MODEL seed requires a header model; the CONTEXT seed does not.
		// They were once a single gate, which meant every conversation whose
		// .llm.jsonl header carries model:"" — the shape persistCliTurn writes
		// for delegated-CLI turns, and nothing ever rewrites it — reported 0%
		// context forever. Resolve the window from whatever model we can name
		// (header > already-retained > config default) and seed the usage
		// regardless.
		if conv != nil {
			convModel := conv.Model
			m.mu.RLock()
			retainedModel := s.lastModel
			m.mu.RUnlock()
			windowModel := convModel
			if windowModel == "" {
				windowModel = retainedModel
			}
			if cfg := m.policyConfig(principal); windowModel == "" && cfg != nil {
				windowModel = cfg.DefaultModel
			}
			ctxWindow := conversation.DefaultContext
			if info := providers.GetModelInfo(windowModel); info != nil && info.ContextWindow > 0 {
				ctxWindow = info.ContextWindow
			}
			// Seed context usage from the persisted conversation so the initial
			// idle engine_status reports the true occupancy instead of 0%.
			// Without this a resumed conversation shows an empty context bar
			// until the first prompt's usage event lands. Computed against the
			// already-loaded conv and the resolved context window.
			//
			// Written unconditionally: a genuine zero on an empty conversation
			// is the correct value. The former `if seededPct > 0` guard is what
			// let a stale non-zero figure survive a conversation being cleared.
			usage := conversation.GetContextUsage(conv, ctxWindow)
			m.mu.Lock()
			if convModel != "" {
				s.setCurrentModel(convModel)
			}
			s.lastContextWindow = ctxWindow
			s.lastContextTokens = usage.Tokens
			s.lastContextPct = usage.Percent
			updateContextCapacityLocked(s, windowModel, ctxWindow, s.config.MaxTokens)
			m.mu.Unlock()
			utils.LogWithFields(utils.LevelInfo, "session", "startsession: seeded from", map[string]any{
				"key": key, "model": convModel, "window_model": windowModel, "ctx_window": ctxWindow,
				"seeded_pct": usage.Percent, "seeded_tokens": usage.Tokens, "estimated": usage.Estimated,
				"conversation_id": s.conversationID,
			})
		} else {
			utils.LogWithFields(utils.LevelDebug, "session", "startsession: no conversation to seed context from", map[string]any{"key": key, "conversation_id": s.conversationID})
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
				utils.LogWithFields(utils.LevelInfo, "session", "startsession: loaded session memory for", map[string]any{"key": key, "conversation_id": s.conversationID})
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
	if len(plans) > 0 {
		m.loadAndWireExtensions(s, key, config, plans)
	}

	// Announce any dispatches rehydration resolved as lost (persisted as
	// running/suspended but dead with the previous engine process). Ordered
	// AFTER extension load so the dispatch_lost hook reaches a live
	// extension group; the typed engine_dispatch_lost event rides the
	// session stream regardless. No-op when rehydration queued nothing.
	m.announceLostDispatches(s, key)
	m.retryRootDispatchCompletions(key)

	// Load skills from default paths. The project root resolves against the
	// session's working directory (not the daemon cwd) via IonSkillPathsFor.
	//
	// Registration is session-scoped: every skill this session loads — user
	// AND project — goes into this session's own map. User skills are copied
	// per session rather than resolved through a shared fallback, so a
	// session's teardown (ClearSkillsFor) can only ever evict its own entries
	// and can never strip a user skill another live session is still using.
	// Project skills therefore reach only sessions whose working directory
	// actually contains them, instead of leaking into every other session
	// through the process-global registry.
	skillPaths := skills.IonSkillPathsFor(config.WorkingDirectory)
	for _, dir := range []struct {
		path  string
		scope string
	}{
		{skillPaths.User, "user"},
		{skillPaths.Project, "project"},
	} {
		if dir.path == "" {
			continue
		}
		loaded, err := skills.LoadSkillDirectory(dir.path, nil)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "session", "skill dir load failed", map[string]any{"key": key, "dir": dir.path, "scope": dir.scope, "error": utils.ErrStr(err)})
			continue
		}
		for _, sk := range loaded {
			skills.RegisterSkillFor(key, sk)
		}
		utils.LogWithFields(utils.LevelInfo, "session", "skill dir loaded", map[string]any{"key": key, "dir": dir.path, "scope": dir.scope, "count": len(loaded)})
	}
	// Load Claude Code–style skills from ~/.claude/skills (one subdir per
	// skill, each with a SKILL.md file). Only attempted when the ClaudeCompat
	// flag is set on the engine config. A missing directory is a silent no-op
	// (returns nil, nil).
	if config.ClaudeCompat {
		if claudeSkills, err := skills.LoadClaudeSkillsDirectory(skillPaths.ClaudeUser); err == nil {
			for _, sk := range claudeSkills {
				skills.RegisterSkillFor(key, sk)
			}
			utils.LogWithFields(utils.LevelInfo, "session", "claude skill dir loaded", map[string]any{"key": key, "dir": skillPaths.ClaudeUser, "scope": "claude-user", "count": len(claudeSkills)})
		}
	} else {
		utils.Debug("Session", "skipping ~/.claude/skills/ (claudeCompat not set)")
	}
	if names := skills.ListSkillNamesFor(key); len(names) > 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "loaded skills", map[string]any{"key": key, "count": len(names), "model": names})
		// Refresh the Skill tool's description so the model's tool manifest
		// lists the available skills (with their when_to_use hints). This
		// must run after all skills are registered; RefreshSkillToolDescription
		// re-registers the Skill tool with a freshly-built manifest.
		//
		// The tool description is process-wide and built from the global
		// registry, so it cannot vary per session. Per-session accuracy comes
		// from the system-prompt section, which buildSystemPrompt assembles
		// per run via BuildSkillSystemPromptSectionFor(opts.SessionKey), and
		// from executeSkill resolving against the calling session's registry.
		tools.RefreshSkillToolDescription()
	}

	// Load and wire Claude Code-compatible plugins (SessionStart hooks + UserPromptSubmit hooks).
	m.loadAndWirePlugins(s, key)

	// MCP servers are NOT connected here — see ensureMcpConnections.
	//
	// This used to be an eager, serial connect loop, and it made session start
	// O(configured servers × network RTT): a desktop rehydrating dozens of tabs
	// calls StartSession once per tab, and one healthy remote server cost each
	// tab ~1.7s (measured: 20 tabs, 32s of blocked rehydration), while an
	// UNREACHABLE server cost each tab up to two 30-second metadata timeouts.
	// Nothing consumes the connections before the first prompt dispatch — the
	// RunConfig is rebuilt from s.mcpConns at every dispatch — so the connect
	// now happens lazily at that seam and only sessions that actually run a
	// prompt pay it.

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

	// Start recovery after every session subsystem is initialized, so its
	// continuation receives the same tools, hooks, skills, and cursors as a
	// normal prompt. The journal itself decides whether work is pending.
	if m.recoverInterruptedRun(s, key) {
		utils.LogWithFields(utils.LevelInfo, "session.recovery", "recovery continuation queued", map[string]any{"key": key, "conversation_id": s.conversationID})
	}

	return &StartSessionResult{Existed: false, ConversationID: s.conversationID, StorageRoot: storageRootFor(principal)}, nil
}

// promoteSessionPrincipalProcessWide stamps the process-wide operator
// identity (telemetry.SetUserIdentity, R20) from a session's principal.
//
// Root cause: correlationCtx/correlationCtxExt (telemetry_ctx.go) never
// carry "principal_identity", so every event built from them --
// extension.coldstart, extension.respawn, extension.hook_latency -- and
// every genuinely process-level event with a nil ctx (system.metrics) falls
// through telemetry.identityForEvent to the process-wide
// resolvedUserIdentity(). On a desktop install where the engine runs its own
// OIDC login (auth.identityProvider), signing in populates that slot
// (server/dispatch_oidc.go's broadcastOidcIdentity) and all of those events
// carry a user. On a hosted instance pod, the owner authenticates through
// the SERVER's own OIDC door (server.json's oidc config, the bearer auth
// door) -- engine.json carries no identityProvider there -- so
// resolvedUserIdentity() was never populated and the same events shipped
// with no user at all, forever, while session/run-scoped events (llm.call,
// tool.execute, dispatch.agent) were already fine: they read the session's
// own principal through ctx.
//
// The fix is at this one origin rather than at each event family: the
// server already tells the engine who is signed in on every
// start_session/send_prompt (types.SessionPrincipal, manifest C1/C2),
// regardless of which door authenticated the person. Promoting that
// principal into the same process-wide slot the engine's own OIDC login
// already uses closes the gap for every current and future event family
// that falls back to it, with no per-event-type carve-out.
//
// Guarded by principal.MultiTenant (added alongside this comment): on an
// engine whose server has POSITIVELY determined that more than one person
// is attributed against it -- a Studio Server install with
// server.json tenancy.mode "isolated" (config/current.ts's
// isSharedTenancy() false), the actual multi-person case, as opposed to a
// personal desktop or a dedicated single-owner instance pod where every
// paired device folds to the same host identity (isSharedTenancy() true) --
// promoting a session's principal process-wide would let whichever person's
// session started most recently overwrite process-level events
// (system.metrics, extension.coldstart, extension.hook_latency) attributed
// to every other person on that engine, and could stomp the engine's own
// OIDC sign-in identity with an unrelated person's. On a multi-tenant
// engine those process-level events instead carry no user at all; each
// session's own events are unaffected because they already read the
// session's principal through ctx (see the root-cause note above), never
// through this process-wide slot.
func promoteSessionPrincipalProcessWide(principal *types.SessionPrincipal) {
	if principal.MultiTenant {
		utils.LogWithFields(utils.LevelDebug, "session.identity", "process-wide identity promotion skipped: multi-tenant engine", map[string]any{"principal_subject": principal.Subject})
		return
	}
	if identity := principal.AttributionForTelemetry(); identity != "" {
		telemetry.SetUserIdentity(identity)
	}
}
