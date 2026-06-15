package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
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

// sessionAccessor adapts *Manager + *engineSession to the
// extcontext.SessionAccessor interface. Each method delegates to the manager
// and session with appropriate locking.
type sessionAccessor struct {
	m   *Manager
	s   *engineSession
	key string
}

func (a *sessionAccessor) SessionKey() string       { return a.key }
func (a *sessionAccessor) ConversationID() string   { return a.s.conversationID }
func (a *sessionAccessor) WorkingDirectory() string  { return a.s.config.WorkingDirectory }

func (a *sessionAccessor) Emit(ev types.EngineEvent) { a.m.emit(a.key, ev) }

func (a *sessionAccessor) SendAbort() { a.m.SendAbort(a.key) }

// RootContext returns the session's cancellation root so extcontext-built
// operations (ctx.llmCall, agent dispatch) derive from it and are cancelled
// by a session-level abort. Never nil — rootContext() falls back to
// context.Background() for test-constructed sessions. See
// session_root_context.go.
func (a *sessionAccessor) RootContext() context.Context { return a.s.rootContext() }

func (a *sessionAccessor) SendPrompt(text string, model string) error {
	var overrides *PromptOverrides
	if model != "" {
		overrides = &PromptOverrides{Model: model}
	}
	return a.m.SendPrompt(a.key, text, overrides)
}

func (a *sessionAccessor) Elicit(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return a.m.elicit(a.s, a.key, info)
}

func (a *sessionAccessor) SuppressTool(name string) {
	a.m.mu.Lock()
	a.s.suppressedTools = append(a.s.suppressedTools, name)
	a.m.mu.Unlock()
}

func (a *sessionAccessor) CacheExtAgentStates(agentStates []types.AgentStateUpdate) {
	a.s.agents.CacheExtStates(agentStates)
}

func (a *sessionAccessor) RegisterAgent(name string, handle types.AgentHandle) {
	a.s.agents.RegisterHandle(name, handle)
}

func (a *sessionAccessor) DeregisterAgent(name string) {
	a.s.agents.DeregisterHandle(name)
}

func (a *sessionAccessor) RegisterAgentSpec(spec types.AgentSpec) {
	a.s.agents.RegisterSpec(spec)
}

func (a *sessionAccessor) DeregisterAgentSpec(name string) {
	a.s.agents.DeregisterSpec(name)
}

func (a *sessionAccessor) LookupAgentSpec(name string) (types.AgentSpec, bool) {
	return a.s.agents.LookupSpec(name)
}

func (a *sessionAccessor) LookupExtDisplayName(name string) string {
	return a.s.agents.LookupExtDisplayName(name)
}

func (a *sessionAccessor) ExtGroup() *extension.ExtensionGroup { return a.s.extGroup }

func (a *sessionAccessor) ExtConfig() *extension.ExtensionConfig {
	if a.s.extGroup != nil && !a.s.extGroup.IsEmpty() {
		return &extension.ExtensionConfig{
			WorkingDirectory: a.s.config.WorkingDirectory,
		}
	}
	return nil
}

func (a *sessionAccessor) ProcRegistry() *extension.ProcessRegistry { return a.s.procRegistry }

func (a *sessionAccessor) NewChildBackend() backend.RunBackend { return a.m.newChildBackend() }

func (a *sessionAccessor) EngineConfig() *types.EngineRuntimeConfig { return a.m.config }

func (a *sessionAccessor) ResolveTier(name string) string { return modelconfig.ResolveTier(name) }

func (a *sessionAccessor) PermissionCheck(toolName string, input map[string]interface{}) (string, string) {
	if a.s.permEngine == nil {
		return "", ""
	}
	result := a.s.permEngine.Check(permissions.CheckInfo{
		Tool:      toolName,
		Input:     input,
		Cwd:       a.s.config.WorkingDirectory,
		SessionID: a.key,
	})
	return result.Decision, result.Reason
}

func (a *sessionAccessor) McpConnections() []*mcp.Connection {
	a.m.mu.RLock()
	defer a.m.mu.RUnlock()
	return a.s.mcpConns
}

func (a *sessionAccessor) SearchHistory(query string, maxResults int) []extension.HistoryMatch {
	a.m.mu.RLock()
	requestID := a.s.requestID
	lastModel := a.s.lastModel
	a.m.mu.RUnlock()
	if requestID == "" {
		return nil
	}
	// resolvedBackend resolves to the inner *ApiBackend for hybrid (when the
	// last dispatched model was non-Anthropic) or returns m.backend as-is
	// for plain ApiBackend. CLI-routed hybrid runs and plain CliBackend
	// return nil here — SearchHistory only operates on the API backend's
	// in-process conversation buffer.
	apiBackend, ok := a.m.resolvedBackend(lastModel).(*backend.ApiBackend)
	if !ok {
		return nil
	}
	convMatches := apiBackend.SearchHistory(requestID, query, maxResults)
	if len(convMatches) == 0 {
		return nil
	}
	// Convert conversation.HistoryMatch → extension.HistoryMatch
	result := make([]extension.HistoryMatch, len(convMatches))
	for i, m := range convMatches {
		result[i] = extension.HistoryMatch{
			Index:     m.Index,
			Role:      m.Role,
			Type:      m.Type,
			Snippet:   m.Snippet,
			ToolName:  m.ToolName,
			ToolUseID: m.ToolUseID,
		}
	}
	return result
}

func (a *sessionAccessor) GetSessionMemory() string {
	a.m.mu.RLock()
	sm := a.s.sessionMemory
	a.m.mu.RUnlock()
	if sm == nil {
		return ""
	}
	return sm.GetMemory()
}

func (a *sessionAccessor) SetSessionMemory(content string) {
	a.m.mu.RLock()
	sm := a.s.sessionMemory
	a.m.mu.RUnlock()
	if sm == nil {
		utils.Log("Session", "SetSessionMemory: no session memory active, ignoring")
		return
	}
	sm.SetMemory(content)
}

func (a *sessionAccessor) TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent {
	return translateToEngineEvent(ev, contextWindow)
}

// SetPlanMode imperatively flips plan mode for this session. Used by
// extensions via ctx.SetPlanMode. Delegates to Manager.SetPlanMode so all
// the planFilePath-preservation and hasExitedPlanMode logic applies.
func (a *sessionAccessor) SetPlanMode(enabled bool, source string) {
	a.m.SetPlanMode(a.key, enabled, nil, source)
}

// GetPlanModeState returns (enabled, planFilePath) for this session.
func (a *sessionAccessor) GetPlanModeState() (bool, string) {
	return a.m.GetPlanModeState(a.key)
}

func (a *sessionAccessor) AppendOrUpdateAgentState(state types.AgentStateUpdate) string {
	a.s.agents.AppendOrUpdate(state, func(existing *types.AgentStateUpdate) {
		// Preserve and merge the structured dispatches array from previous
		// dispatches. When the incoming state carries new dispatch entries
		// (e.g. a re-dispatch of the same agent name), merge them with any
		// existing entries rather than replacing.
		var prevDispatches []interface{}
		if existing.Metadata != nil {
			if pd, ok := existing.Metadata["dispatches"].([]interface{}); ok {
				prevDispatches = pd
			}
		}
		existing.ID = state.ID
		existing.Status = state.Status
		existing.Metadata = state.Metadata
		if len(prevDispatches) > 0 && existing.Metadata != nil {
			if newDisp, ok := existing.Metadata["dispatches"].([]interface{}); ok {
				existing.Metadata["dispatches"] = append(prevDispatches, newDisp...)
			} else {
				existing.Metadata["dispatches"] = prevDispatches
			}
		}
	})
	return state.ID
}

func (a *sessionAccessor) UpdateAgentStateByID(id string, updater func(*types.AgentStateUpdate)) {
	a.s.agents.UpdateStateByID(id, updater)
}

func (a *sessionAccessor) EmitAgentSnapshot(reason string) {
	snapshot := a.s.agents.MergedSnapshot()
	utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=%s", a.key, len(snapshot), reason))
	a.m.emit(a.key, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})
}

func (a *sessionAccessor) ResourceBroker() *resource.Broker       { return a.s.resourceBroker }
func (a *sessionAccessor) GlobalResourceBroker() *resource.Broker { return a.m.globalBroker }

// BroadcastNotification emits an engine_notification event with push flags
// set so the relay forwards it to APNs when the mobile peer is offline.
// When TargetSessionKey is set, the notification is emitted on the target
// session's event stream instead of the caller's. The target must exist;
// if it doesn't, the notification is emitted on the caller's session and
// a warning is logged.
func (a *sessionAccessor) BroadcastNotification(opts types.NotifyOpts) {
	ev := types.EngineEvent{
		Type:             "engine_notification",
		Push:             true,
		PushTitle:        opts.Title,
		PushBody:         opts.Body,
		NotifyKind:       opts.Kind,
		NotifyResourceID: opts.ResourceID,
		NotifyTitle:      opts.Title,
		NotifyBody:       opts.Body,
		NotifySound:      opts.Sound,
		NotifyScope:      opts.Scope,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		// Verify the target session exists.
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.Log("session", fmt.Sprintf("BroadcastNotification: routing to target session key=%s (from %s)", targetKey, a.key))
			a.m.emit(targetKey, ev)
			return
		}
		utils.Warn("session", fmt.Sprintf("BroadcastNotification: target session %q not found, falling back to caller %s", targetKey, a.key))
	}

	a.m.emit(a.key, ev)
}

// BroadcastIntercept emits an engine_intercept event on the target session's
// stream. This is a fire-and-forget signal — the engine attaches no semantics
// beyond routing the event. When TargetSessionKey is set and the session
// exists, the event is emitted on that session's stream. Otherwise it falls
// back to the caller's session and a warning is logged.
func (a *sessionAccessor) BroadcastIntercept(opts extension.InterceptOpts) {
	ev := types.EngineEvent{
		Type:              "engine_intercept",
		InterceptLevel:    opts.Level,
		InterceptTitle:    opts.Title,
		InterceptMessage:  opts.Message,
		InterceptSource:   opts.Source,
		InterceptMetadata: opts.Metadata,
	}

	targetKey := opts.TargetSessionKey
	if targetKey != "" && targetKey != a.key {
		a.m.mu.RLock()
		_, exists := a.m.sessions[targetKey]
		a.m.mu.RUnlock()
		if exists {
			utils.Log("session", fmt.Sprintf("BroadcastIntercept: routing to target session key=%s (from %s)", targetKey, a.key))
			a.m.emit(targetKey, ev)
			return
		}
		utils.Warn("session", fmt.Sprintf("BroadcastIntercept: target session %q not found, falling back to caller %s", targetKey, a.key))
	}

	a.m.emit(a.key, ev)
}

func (a *sessionAccessor) ListAllSessions() []extension.SessionListEntry {
	infos := a.m.ListSessions()
	entries := make([]extension.SessionListEntry, len(infos))
	for i, info := range infos {
		entries[i] = extension.SessionListEntry{
			Key:            info.Key,
			HasActiveRun:   info.HasActiveRun,
			ExtensionName:  info.ExtensionName,
			ConversationID: info.ConversationID,
		}
	}
	return entries
}

func (a *sessionAccessor) SendToSession(senderKey, targetKey, kind string, payload map[string]interface{}) error {
	a.m.mu.RLock()
	senderSession, senderOK := a.m.sessions[senderKey]
	targetSession, targetOK := a.m.sessions[targetKey]
	a.m.mu.RUnlock()

	if !targetOK {
		return fmt.Errorf("target session %q not found", targetKey)
	}
	if !senderOK {
		return fmt.Errorf("sender session %q not found", senderKey)
	}

	// Enforce same extension type.
	if senderSession.extensionName != targetSession.extensionName {
		return fmt.Errorf("cross-session messaging requires same extension type (sender=%q target=%q)",
			senderSession.extensionName, targetSession.extensionName)
	}

	// Check the target session has an extension group.
	if targetSession.extGroup == nil || targetSession.extGroup.IsEmpty() {
		return fmt.Errorf("target session %q has no extension group", targetKey)
	}

	// Fire the session_message hook on each host in the target session's
	// extension group, using the target session's context.
	info := extension.SessionMessageInfo{
		SenderSessionKey: senderKey,
		Kind:             kind,
		Payload:          payload,
	}

	ctx := a.m.newExtContext(targetSession, targetKey)
	for _, h := range targetSession.extGroup.Hosts() {
		if err := h.SDK().FireSessionMessage(ctx, info); err != nil {
			utils.Log("session", fmt.Sprintf("SendToSession: hook fire failed sender=%s target=%s kind=%s err=%v", senderKey, targetKey, kind, err))
		}
	}

	utils.Log("session", fmt.Sprintf("SendToSession: delivered sender=%s target=%s kind=%s", senderKey, targetKey, kind))
	return nil
}

// RunOnceCheck delegates to the Manager's runOnce registry, scoped to this
// session's loaded extension directory.
func (a *sessionAccessor) RunOnceCheck(operationID string, debounceMs int64) (bool, string) {
	result := a.m.RunOnceCheck(a.key, operationID, debounceMs)
	return result.Execute, result.Reason
}

// RunOnceComplete delegates to the Manager's runOnce registry.
func (a *sessionAccessor) RunOnceComplete(operationID string, failed bool) {
	a.m.RunOnceComplete(a.key, operationID, failed)
}

// newExtContext builds a fully-populated extension Context for the given session.
// All functional callbacks are wired through the extcontext.SessionAccessor interface.
func (m *Manager) newExtContext(s *engineSession, key string) *extension.Context {
	return extcontext.NewExtContext(&sessionAccessor{m: m, s: s, key: key}, s.dispatchRegistry)
}

// StartSession creates a new session with the given config.
func (m *Manager) StartSession(key string, config types.EngineConfig) (*StartSessionResult, error) {
	utils.Info("Session", fmt.Sprintf("StartSession: key=%s dir=%s extensions=%d", key, config.WorkingDirectory, len(config.Extensions)))
	m.mu.Lock()

	if s, exists := m.sessions[key]; exists {
		convID := s.conversationID
		needsExtensions := len(config.Extensions) > 0 && (s.extGroup == nil || s.extGroup.IsEmpty())
		m.mu.Unlock()

		// Re-register extensions when the session was restored without them
		// (e.g. daemon restart where the extension subprocess was not persisted).
		if needsExtensions {
			utils.Log("Session", fmt.Sprintf("StartSession: key=%s re-registering %d extensions on existing session", key, len(config.Extensions)))
			m.loadAndWireExtensions(s, key, config)
		}

		utils.Log("Session", fmt.Sprintf("StartSession: key=%s already exists (idempotent, conversationID=%s)", key, convID))
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

	s := &engineSession{
		key:              key,
		config:           config,
		conversationID:   convID,
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
		utils.Log("session", fmt.Sprintf("StartSession key=%s: process registry unavailable: %v", key, err))
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

	m.sessions[key] = s

	m.mu.Unlock()

	// Persist the key->conversationId binding for restart resilience (B2 fix
	// for issue #230). Written immediately after session creation so a crash
	// mid-startup still leaves the binding on disk for the next restart.
	saveBinding(bindingsPath(), key, convID)

	// Rehydrate agent dispatch state from the conversation file if the
	// session is resuming an existing conversation. This runs before
	// extensions fire session_start so the agent registry is pre-populated
	// with completed dispatches. When the extension later emits its fresh
	// roster, MergedSnapshot deduplicates: engine-managed entries (with
	// task, conversationId, elapsed) win over the extension's idle entries.
	if s.conversationID != "" {
		m.rehydrateDispatchState(s, key)

		// Seed lastModel from the conversation file so ReconcileState emits
		// the correct model before any prompt dispatches. Without this, a
		// resumed session emits model="" on reconcile, causing the desktop to
		// fall back to its preference default (which may differ from the
		// conversation's actual model). This also seeds lastContextWindow so
		// the context-percent denominator is correct from the first status.
		if convModel, err := conversation.LoadLlmHeaderModel(s.conversationID, ""); err == nil && convModel != "" {
			ctxWindow := conversation.DefaultContext
			if info := providers.GetModelInfo(convModel); info != nil {
				ctxWindow = info.ContextWindow
			}
			m.mu.Lock()
			s.lastModel = convModel
			s.lastContextWindow = ctxWindow
			m.mu.Unlock()
			utils.Log("Session", fmt.Sprintf("StartSession: key=%s seeded lastModel=%s contextWindow=%d from conversation=%s", key, convModel, ctxWindow, s.conversationID))
		} else if err != nil {
			utils.Debug("Session", fmt.Sprintf("StartSession: key=%s could not load conversation model conv=%s err=%v", key, s.conversationID, err))
		}

		// Initialize session memory for resumed conversations. The memory
		// file (if it exists) is loaded from disk so the first compaction
		// on this session can use the pre-existing summary as a zero-cost
		// context restoration source. The memory updater starts via
		// Start() and will be stopped by StopSession.
		memoryDisabled := m.config != nil && m.config.Compaction != nil &&
			m.config.Compaction.MemoryEnabled != nil && !*m.config.Compaction.MemoryEnabled
		if !memoryDisabled {
			home, _ := os.UserHomeDir()
			convDir := filepath.Join(home, ".ion", "conversations")
			sm := NewSessionMemory(s.conversationID, convDir, nil)
			if sm.LoadMemory() {
				utils.Log("Session", fmt.Sprintf("StartSession: key=%s loaded session memory for conv=%s", key, s.conversationID))
			}
			sm.Start()
			m.mu.Lock()
			s.sessionMemory = sm
			m.mu.Unlock()
		} else {
			utils.Log("Session", fmt.Sprintf("StartSession: key=%s session memory disabled by config", key))
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
		utils.Log("Session", fmt.Sprintf("loaded %d skills: %v", len(names), names))
		// Refresh the Skill tool's description so the model's tool manifest
		// lists the available skills (with their when_to_use hints). This
		// must run after all skills are registered; RefreshSkillToolDescription
		// re-registers the Skill tool with a freshly-built manifest.
		tools.RefreshSkillToolDescription()
	}

	// Connect MCP servers from config (outside lock)
	if m.config != nil && len(m.config.McpServers) > 0 {
		m.emit(key, types.EngineEvent{
			Type:         "engine_working_message",
			EventMessage: "Connecting MCP servers...",
		})
		for name, mcpCfg := range m.config.McpServers {
			conn, err := mcp.Connect(name, mcpCfg)
			if err != nil {
				utils.Log("Session", fmt.Sprintf("MCP connect %s failed: %s", name, err))
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
				utils.Log("Session", fmt.Sprintf("MCP %s: session %s disposed during connect — closing leaked conn", name, key))
				continue
			}
			s.mcpConns = append(s.mcpConns, conn)
			m.mu.Unlock()
			utils.Log("Session", fmt.Sprintf("MCP server %s connected (%d tools)", name, len(conn.Tools())))
		}
	}

	m.emit(key, types.EngineEvent{
		Type:         "engine_working_message",
		EventMessage: "",
	})
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle", SessionID: s.conversationID},
	})

	return &StartSessionResult{Existed: false, ConversationID: s.conversationID}, nil
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
			utils.Log("Session", "extension load failed for "+extPath+": "+err.Error())
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension load failed: %s", err.Error()),
				ErrorCode:    "extension_load_failed",
			})
			continue
		}
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

	// Wire send_message and persistent emit on each host
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
				// Cache the extension's roster, then re-emit a merged snapshot
				// that includes engine-managed entries (dispatch state with
				// task, conversationId, progress). Forwarding the extension's
				// raw event would overwrite engine-managed entries on the
				// desktop due to the complete-snapshot contract.
				s.agents.CacheExtStates(ev.Agents)
				merged := s.agents.MergedSnapshot()
				utils.Log("Session", fmt.Sprintf("agent_snapshot_emitted key=%s count=%d reason=ext_emit_merged", capturedKey, len(merged)))
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
	utils.Log("Session", fmt.Sprintf("loadAndWireExtensions: wired %d onCommandsChange observers for key=%s", len(group.Hosts()), key))
}
