package session

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/telemetry"
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
func (a *sessionAccessor) WorkingDirectory() string  { return a.s.config.WorkingDirectory }

func (a *sessionAccessor) Emit(ev types.EngineEvent) { a.m.emit(a.key, ev) }

func (a *sessionAccessor) SendAbort() { a.m.SendAbort(a.key) }

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
	a.m.mu.RUnlock()
	if requestID == "" {
		return nil
	}
	apiBackend, ok := a.m.backend.(*backend.ApiBackend)
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

func (a *sessionAccessor) TranslateEvent(ev types.NormalizedEvent, contextWindow int) types.EngineEvent {
	return translateToEngineEvent(ev, contextWindow)
}

// newExtContext builds a fully-populated extension Context for the given session.
// All functional callbacks are wired through the extcontext.SessionAccessor interface.
func (m *Manager) newExtContext(s *engineSession, key string) *extension.Context {
	return extcontext.NewExtContext(&sessionAccessor{m: m, s: s, key: key})
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

	s := &engineSession{
		key:            key,
		config:         config,
		conversationID:  config.SessionID,
		agents:         agents.NewRegistry(),
		childPIDs:      make(map[int]struct{}),
		pending:        pending.New(),
		maxQueueDepth:  32,
	}

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

	// Signal that session startup is in progress so clients can show loading UI.
	// Events flow through the socket broadcast independently of the request-response
	// ACK, so the desktop receives these before StartSession returns.
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
	if names := skills.ListSkillNames(); len(names) > 0 {
		utils.Log("Session", fmt.Sprintf("loaded %d skills", len(names)))
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
				s.agents.CacheExtStates(ev.Agents)
			}
			if ev.Type == "engine_status" && ev.Fields != nil && ev.Fields.ExtensionName != "" {
				m.mu.Lock()
				s.extensionName = ev.Fields.ExtensionName
				m.mu.Unlock()
			}
			m.emit(capturedKey, ev)
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

	// Discover capabilities from extensions
	caps := group.FireCapabilityDiscover(ctx)
	for _, cap := range caps {
		for _, host := range group.Hosts() {
			host.SDK().RegisterCapability(cap)
		}
	}
}
