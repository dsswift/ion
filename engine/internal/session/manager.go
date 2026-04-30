package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/agentdiscovery"
	"github.com/dsswift/ion/engine/internal/backend"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	ioncontext "github.com/dsswift/ion/engine/internal/context"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/gitcontext"
	"github.com/dsswift/ion/engine/internal/export"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/recorder"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// pendingPrompt holds a queued prompt waiting for the active run to finish.
type pendingPrompt struct {
	text         string
	model        string
	maxTurns     int
	maxBudgetUsd float64
	extensions   []string
	noExtensions bool
}

// engineSession holds the state for a single session managed by the Manager.
type engineSession struct {
	key           string
	config        types.EngineConfig
	requestID     string // empty when no active run
	conversationID string
	agentRegistry      map[string]types.AgentHandle
	agentSpecs         map[string]types.AgentSpec
	agentStates        []types.AgentStateUpdate
	lastExtAgentStates []types.AgentStateUpdate
	suppressedTools    []string
	childPIDs     map[int]struct{}
	planMode           bool
	planModeTools      []string
	planFilePath       string
	planModePromptSent bool
	promptQueue   []pendingPrompt
	maxQueueDepth int // default 32

	// Wired subsystems (populated in StartSession)
	extGroup       *extension.ExtensionGroup
	mcpConns       []*mcp.Connection
	permEngine     *permissions.Engine
	telemetry      *telemetry.Collector
	recorder       *recorder.Recorder
	toolServer     *backend.ToolServer
	procRegistry   *extension.ProcessRegistry
	pendingDialogs     map[string]chan interface{}
	pendingPermissions map[string]chan string
	pendingElicit      map[string]chan elicitReply
}

// elicitReply carries a client's response to an engine_elicitation_request event.
type elicitReply struct {
	response  map[string]interface{}
	cancelled bool
}

// SessionInfo describes a session in the list response.
type SessionInfo struct {
	Key            string `json:"key"`
	HasActiveRun   bool   `json:"hasActiveRun"`
	ToolCount      int    `json:"toolCount"`
	ConversationID string `json:"conversationId,omitempty"`
}

// StartSessionResult carries information about the session after a StartSession call.
type StartSessionResult struct {
	Existed        bool   `json:"existed"`
	ConversationID string `json:"conversationId,omitempty"`
}

// Manager orchestrates multiple engine sessions, routing prompts to the
// backend and forwarding events to connected clients.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*engineSession
	backend  backend.RunBackend
	config   *types.EngineRuntimeConfig

	onEvent func(string, types.EngineEvent)
}

// SetConfig stores the engine runtime config for applying defaults.
func (m *Manager) SetConfig(cfg *types.EngineRuntimeConfig) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cfg
}

// GetTelemetryConfig returns the engine telemetry config. Nil if telemetry
// not configured. Harness can use for self-diagnostics.
func (m *Manager) GetTelemetryConfig() *types.TelemetryConfig {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.config == nil {
		return nil
	}
	return m.config.Telemetry
}

// newExtContext builds a fully-populated extension Context for the given session.
// All functional callbacks are wired to the session manager's internals.
func (m *Manager) newExtContext(s *engineSession, key string) *extension.Context {
	ctx := &extension.Context{
		SessionKey: key,
		Cwd:        s.config.WorkingDirectory,
		Emit: func(ev types.EngineEvent) {
			// Cache extension-emitted agent states so the built-in Agent tool
			// spawner can merge them into its own snapshots.
			if ev.Type == "engine_agent_state" {
				m.mu.Lock()
				s.lastExtAgentStates = make([]types.AgentStateUpdate, len(ev.Agents))
				copy(s.lastExtAgentStates, ev.Agents)
				m.mu.Unlock()
			}
			m.emit(key, ev)
		},
		Abort: func() { m.SendAbort(key) },
		RegisterAgent: func(name string, handle types.AgentHandle) {
			m.mu.Lock()
			s.agentRegistry[name] = handle
			m.mu.Unlock()
		},
		DeregisterAgent: func(name string) {
			m.mu.Lock()
			delete(s.agentRegistry, name)
			m.mu.Unlock()
		},
		RegisterAgentSpec: func(spec types.AgentSpec) {
			if spec.Name == "" {
				return
			}
			m.mu.Lock()
			s.agentSpecs[spec.Name] = spec
			m.mu.Unlock()
		},
		DeregisterAgentSpec: func(name string) {
			m.mu.Lock()
			delete(s.agentSpecs, name)
			m.mu.Unlock()
		},
		LookupAgentSpec: func(name string) (types.AgentSpec, bool) {
			m.mu.RLock()
			defer m.mu.RUnlock()
			spec, ok := s.agentSpecs[name]
			return spec, ok
		},
		ResolveTier: func(name string) string {
			return modelconfig.ResolveTier(name)
		},
		SuppressTool: func(name string) {
			m.mu.Lock()
			s.suppressedTools = append(s.suppressedTools, name)
			m.mu.Unlock()
		},
		Elicit: func(info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
			return m.elicit(s, key, info)
		},
		CallTool: func(toolName string, input map[string]interface{}) (string, bool, error) {
			return m.callToolFromExtension(s, key, toolName, input)
		},
		SendPrompt: func(text string, model string) error {
			var overrides *PromptOverrides
			if model != "" {
				overrides = &PromptOverrides{Model: model}
			}
			return m.SendPrompt(key, text, overrides)
		},
	}
	// Wire process lifecycle management
	if s.procRegistry != nil {
		reg := s.procRegistry
		ctx.RegisterProcess = func(name string, pid int, task string) error {
			return reg.Register(name, pid, task)
		}
		ctx.DeregisterProcess = func(name string) {
			reg.Deregister(name)
		}
		ctx.ListProcesses = func() []extension.ProcessInfo {
			return reg.List()
		}
		ctx.TerminateProcess = func(name string) error {
			return reg.Terminate(name)
		}
		ctx.CleanStaleProcesses = func() int {
			return reg.CleanStale()
		}
	}

	// Wire engine-native agent dispatch
	ctx.DispatchAgent = func(opts extension.DispatchAgentOpts) (*extension.DispatchAgentResult, error) {
		start := time.Now()

		// Determine model and project path
		model := opts.Model
		if model == "" && m.config != nil {
			model = m.config.DefaultModel
		}
		projectPath := opts.ProjectPath
		if projectPath == "" {
			projectPath = s.config.WorkingDirectory
		}

		// Create child backend
		child := backend.NewApiBackend()
		var childCfg *backend.RunConfig

		// Load extension if specified
		var childExtHost *extension.Host
		if opts.ExtensionDir != "" {
			childExtHost = extension.NewHost()
			extCfg := &extension.ExtensionConfig{
				ExtensionDir:     opts.ExtensionDir,
				Model:            model,
				WorkingDirectory: projectPath,
			}
			if err := childExtHost.Load(opts.ExtensionDir, extCfg); err != nil {
				utils.Log("Session", "child extension load failed: "+err.Error())
				childExtHost = nil
			} else {
				// Fire session_start on child extension
				childCtx := m.newExtContext(s, key)
				childExtHost.FireSessionStart(childCtx)

				// Wire before_agent_start for system prompt
				basCtx := m.newExtContext(s, key)
				extSysPrompt, _ := childExtHost.FireBeforeAgentStart(basCtx, extension.AgentInfo{
					Name: opts.Name,
					Task: opts.Task,
				})
				if extSysPrompt != "" {
					if opts.SystemPrompt != "" {
						opts.SystemPrompt = opts.SystemPrompt + "\n\n" + extSysPrompt
					} else {
						opts.SystemPrompt = extSysPrompt
					}
				}

				// Wire tool_call hook for damage-control etc.
				childCfg = &backend.RunConfig{
					Hooks: backend.RunHooks{
						OnToolCall: func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
							tcCtx := m.newExtContext(s, key)
							result, _ := childExtHost.FireToolCall(tcCtx, extension.ToolCallInfo{
								ToolName: info.ToolName,
								ToolID:   info.ToolID,
								Input:    info.Input,
							})
							if result != nil && result.Block {
								return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
							}
							return nil, nil
						},
					},
				}
			}
		}

		// Route child events to parent event bus and optional extension callback
		var totalCost float64
		var totalInputTokens, totalOutputTokens int
		var childSessionID string

		var result string
		var childErr error
		var childDone sync.WaitGroup
		childDone.Add(1)

		child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
			// Route to parent event bus and optional extension callback
			ee := translateToEngineEvent(ev, 0)
			if ee.Type != "" {
				m.emit(key, ee)
				if opts.OnEvent != nil {
					opts.OnEvent(ee)
				}
			}
			// Capture final result, cost, and session ID from TaskCompleteEvent
			if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
				result = tc.Result
				totalCost = tc.CostUsd
				if tc.Usage.InputTokens != nil {
					totalInputTokens = *tc.Usage.InputTokens
				}
				if tc.Usage.OutputTokens != nil {
					totalOutputTokens = *tc.Usage.OutputTokens
				}
				if tc.SessionID != "" {
					childSessionID = tc.SessionID
				}
			}
		})
		child.OnExit(func(_ string, _ *int, _ *string, _ string) {
			childDone.Done()
		})
		child.OnError(func(_ string, err error) {
			childErr = err
		})

		runOpts := types.RunOptions{
			Prompt:      opts.Task,
			Model:       model,
			ProjectPath: projectPath,
		}
		if opts.SystemPrompt != "" {
			runOpts.AppendSystemPrompt = opts.SystemPrompt
		}
		if opts.SessionID != "" {
			runOpts.SessionID = opts.SessionID
		}
		if opts.MaxTurns > 0 {
			runOpts.MaxTurns = opts.MaxTurns
		}

		child.StartRunWithConfig(fmt.Sprintf("%s-dispatch-%s", key, opts.Name), runOpts, childCfg)
		childDone.Wait()

		elapsed := time.Since(start).Seconds()

		// Cleanup child extension
		if childExtHost != nil {
			childExtHost.Dispose()
		}

		exitCode := 0
		if childErr != nil {
			exitCode = 1
			return &extension.DispatchAgentResult{
				Output:       childErr.Error(),
				ExitCode:     exitCode,
				Elapsed:      elapsed,
				Cost:         totalCost,
				InputTokens:  totalInputTokens,
				OutputTokens: totalOutputTokens,
				SessionID:    childSessionID,
			}, childErr
		}

		return &extension.DispatchAgentResult{
			Output:       result,
			ExitCode:     0,
			Elapsed:      elapsed,
			Cost:         totalCost,
			InputTokens:  totalInputTokens,
			OutputTokens: totalOutputTokens,
			SessionID:    childSessionID,
		}, nil
	}

	// Populate extension config if available
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx.Config = &extension.ExtensionConfig{
			WorkingDirectory: s.config.WorkingDirectory,
		}
	}

	// Wire agent discovery
	ctx.DiscoverAgents = func(opts extension.DiscoverAgentsOpts) (*extension.DiscoverAgentsResult, error) {
		sources := opts.Sources
		if len(sources) == 0 {
			sources = []string{"extension", "user", "project"}
		}

		// Build ordered directory list. Later dirs override earlier (reverse of WalkOptions
		// where first-seen wins). We reverse the source order before passing to WalkAgentFiles
		// so that later sources in the harness engineer's list take precedence.
		var dirs []string
		sourceMap := make(map[string]string) // dir -> source label

		home, _ := os.UserHomeDir()
		extDir := ""
		if ctx.Config != nil {
			extDir = ctx.Config.ExtensionDir
		}

		for _, src := range sources {
			var dir string
			switch src {
			case "extension":
				if extDir != "" {
					dir = filepath.Join(extDir, "agents")
				}
			case "user":
				if home != "" {
					dir = filepath.Join(home, ".ion", "agents")
				}
			case "project":
				if s.config.WorkingDirectory != "" {
					dir = filepath.Join(s.config.WorkingDirectory, ".ion", "agents")
				}
			default:
				continue
			}
			if dir != "" {
				if opts.BundleName != "" {
					dir = filepath.Join(dir, opts.BundleName)
				}
				dirs = append(dirs, dir)
				sourceMap[dir] = src
			}
		}

		// Add extra dirs
		for _, d := range opts.ExtraDirs {
			dirs = append(dirs, d)
			sourceMap[d] = "extra"
		}

		// Reverse dirs so last source wins dedup (WalkAgentFiles uses first-seen-wins)
		for i, j := 0, len(dirs)-1; i < j; i, j = i+1, j-1 {
			dirs[i], dirs[j] = dirs[j], dirs[i]
		}

		recursive := true
		if opts.Recursive != nil {
			recursive = *opts.Recursive
		}

		walkOpts := agentdiscovery.WalkOptions{
			ExtraDirs: dirs,
			Recursive: recursive,
		}

		graph, err := agentdiscovery.Discover(walkOpts)
		if err != nil {
			return nil, err
		}

		var result []extension.DiscoveredAgent
		for _, def := range graph.Agents {
			// Determine source from path
			source := "unknown"
			for dir, label := range sourceMap {
				if strings.HasPrefix(def.Path, dir) {
					source = label
					break
				}
			}
			result = append(result, extension.DiscoveredAgent{
				Name:         def.Name,
				Path:         def.Path,
				Source:       source,
				Parent:       def.Parent,
				Description:  def.Description,
				Model:        def.Model,
				Tools:        def.Tools,
				SystemPrompt: def.SystemPrompt,
				Meta:         def.Meta,
			})
		}
		return &extension.DiscoverAgentsResult{Agents: result}, nil
	}

	return ctx
}

// NewManager creates a Manager wired to the given backend.
// It registers normalized/exit/error listeners on the backend so that
// events are translated and forwarded through OnEvent.
func NewManager(b backend.RunBackend) *Manager {
	m := &Manager{
		sessions: make(map[string]*engineSession),
		backend:  b,
	}

	b.OnNormalized(m.handleNormalizedEvent)
	b.OnExit(m.handleRunExit)
	b.OnError(m.handleRunError)

	return m
}

// callToolFromExtension dispatches an extension-initiated tool call through
// the session's tool registry: built-in tools, MCP-registered tools, and
// extension-registered tools (any host in the loaded group).
//
// Permission policy (s.permEngine) gates the call: deny rules return an
// error result, "ask" decisions auto-deny because extension calls cannot
// block on user elicitation. Per-tool hooks (`bash_tool_call`, etc.) and
// `permission_request` are NOT fired -- they would re-enter the calling
// extension and create surprising recursion.
//
// Returns (content, isError, err). A non-nil err is reserved for unknown
// tool names so the SDK can surface a Promise rejection on what is almost
// always a programming error. Tool-internal failures resolve as
// (errorMessage, true, nil).
func (m *Manager) callToolFromExtension(s *engineSession, sessionKey, toolName string, input map[string]interface{}) (string, bool, error) {
	if input == nil {
		input = map[string]interface{}{}
	}

	// Permission gate.
	if s.permEngine != nil {
		result := s.permEngine.Check(permissions.CheckInfo{
			Tool:      toolName,
			Input:     input,
			Cwd:       s.config.WorkingDirectory,
			SessionID: sessionKey,
		})
		switch result.Decision {
		case "allow":
			// proceed
		case "deny":
			reason := result.Reason
			if reason == "" {
				reason = "denied by policy"
			}
			return fmt.Sprintf("Permission denied: %s", reason), true, nil
		case "ask":
			return fmt.Sprintf(
				"Permission requires user approval (rule: %s); extension calls cannot block on elicitation. Configure an explicit allow rule for %q in your permission policy.",
				result.Reason, toolName,
			), true, nil
		default:
			return fmt.Sprintf("Permission engine returned unknown decision: %q", result.Decision), true, nil
		}
	}

	cwd := s.config.WorkingDirectory

	// 1. Built-in tools (Read, Write, Edit, Bash, Grep, Glob, Agent, etc).
	if tools.GetTool(toolName) != nil {
		toolResult, err := tools.ExecuteTool(context.Background(), toolName, input, cwd)
		if err != nil {
			return "", true, err
		}
		if toolResult == nil {
			return "", false, nil
		}
		return toolResult.Content, toolResult.IsError, nil
	}

	// 2. MCP-registered tools (mcp__server__tool prefix).
	if strings.HasPrefix(toolName, "mcp__") {
		m.mu.RLock()
		mcpConns := s.mcpConns
		m.mu.RUnlock()
		parts := strings.SplitN(toolName, "__", 3)
		if len(parts) != 3 {
			return fmt.Sprintf("Invalid MCP tool name: %s", toolName), true, nil
		}
		serverName := parts[1]
		innerName := parts[2]
		for _, conn := range mcpConns {
			if conn.Name() == serverName {
				content, err := conn.CallTool(innerName, input)
				if err != nil {
					return "", true, err
				}
				return content, false, nil
			}
		}
		return fmt.Sprintf("MCP server %q not connected", serverName), true, nil
	}

	// 3. Extension-registered tools (any host in the loaded group).
	if s.extGroup != nil {
		for _, tool := range s.extGroup.Tools() {
			if tool.Name == toolName {
				ctx := m.newExtContext(s, sessionKey)
				result, err := tool.Execute(input, ctx)
				if err != nil {
					return "", true, err
				}
				if result == nil {
					return "", false, nil
				}
				return result.Content, result.IsError, nil
			}
		}
	}

	// 4. Unknown -- programming error in the calling extension.
	return "", true, fmt.Errorf("unknown tool: %s", toolName)
}

// OnEvent registers the event callback. The key identifies which session
// produced the event.
func (m *Manager) OnEvent(fn func(string, types.EngineEvent)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onEvent = fn
}

func (m *Manager) emit(key string, event types.EngineEvent) {
	m.mu.RLock()
	fn := m.onEvent
	m.mu.RUnlock()
	if fn != nil {
		fn(key, event)
	}
}

// ListSessions returns info for all active sessions.
func (m *Manager) ListSessions() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]SessionInfo, 0, len(m.sessions))
	for _, s := range m.sessions {
		toolCount := 0
		if s.extGroup != nil && !s.extGroup.IsEmpty() {
			toolCount = len(s.extGroup.Tools())
		}
		// Count MCP tools
		for _, conn := range s.mcpConns {
			toolCount += len(conn.Tools())
		}
		result = append(result, SessionInfo{
			Key:            s.key,
			HasActiveRun:   s.requestID != "",
			ToolCount:      toolCount,
			ConversationID: s.conversationID,
		})
	}
	return result
}

// StartSession creates a new session with the given config.
func (m *Manager) StartSession(key string, config types.EngineConfig) (*StartSessionResult, error) {
	utils.Info("Session", fmt.Sprintf("StartSession: key=%s dir=%s extensions=%d", key, config.WorkingDirectory, len(config.Extensions)))
	m.mu.Lock()

	if s, exists := m.sessions[key]; exists {
		convID := s.conversationID
		m.mu.Unlock()
		utils.Log("Session", fmt.Sprintf("StartSession: key=%s already exists (idempotent, conversationID=%s)", key, convID))
		return &StartSessionResult{Existed: true, ConversationID: convID}, nil
	}

	s := &engineSession{
		key:            key,
		config:         config,
		conversationID:  config.SessionID,
		agentRegistry:  make(map[string]types.AgentHandle),
		agentSpecs:     make(map[string]types.AgentSpec),
		childPIDs:      make(map[int]struct{}),
		pendingDialogs:     make(map[string]chan interface{}),
		pendingPermissions: make(map[string]chan string),
		pendingElicit:      make(map[string]chan elicitReply),
		maxQueueDepth:  32,
	}

	// Initialize process registry for extension-spawned subprocesses
	home, _ := os.UserHomeDir()
	pidsDir := filepath.Join(home, ".ion", "agent-pids")
	s.procRegistry = extension.NewProcessRegistry(pidsDir)

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
	extPaths := config.Extensions
	if len(extPaths) > 0 {
		group := extension.NewExtensionGroup()
		for _, extPath := range extPaths {
			m.emit(key, types.EngineEvent{
				Type:         "engine_working_message",
				EventMessage: fmt.Sprintf("Loading extension: %s", filepath.Base(filepath.Dir(extPath))),
			})
			host := extension.NewHost()

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
			// Wire death detection so we can auto-respawn after the
			// active run finishes. Captured key intentionally — host
			// outlives this loop iteration.
			capturedKey := key
			host.SetOnDeath(func(h *extension.Host) {
				m.handleHostDeath(capturedKey, h)
			})
			group.Add(host)
		}
		if !group.IsEmpty() {
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
						m.mu.Lock()
						s.lastExtAgentStates = make([]types.AgentStateUpdate, len(ev.Agents))
						copy(s.lastExtAgentStates, ev.Agents)
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
			group.FireSessionStart(ctx)

			// Discover capabilities from extensions
			caps := group.FireCapabilityDiscover(ctx)
			for _, cap := range caps {
				for _, host := range group.Hosts() {
					host.SDK().RegisterCapability(cap)
				}
			}
		}
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

// SendPrompt dispatches a prompt to the session's backend run.
// PromptOverrides holds per-prompt overrides from the client command.
type PromptOverrides struct {
	Model              string
	MaxTurns           int
	MaxBudgetUsd       float64
	Extensions         []string
	NoExtensions       bool
	AppendSystemPrompt string
}

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
		if len(s.promptQueue) >= s.maxQueueDepth {
			m.mu.Unlock()
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("session %q prompt queue full (%d)", key, s.maxQueueDepth),
				ErrorCode:    "queue_full",
			})
			return fmt.Errorf("session %q prompt queue full (%d)", key, s.maxQueueDepth)
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
		m.mu.Unlock()
		return nil
	}

	requestID := fmt.Sprintf("%s-%d", key, time.Now().UnixMilli())
	s.requestID = requestID

	// Generate plan file path if plan mode is active and no path exists yet
	if s.planMode && s.planFilePath == "" {
		home, _ := os.UserHomeDir()
		plansDir := filepath.Join(home, ".ion", "plans")
		os.MkdirAll(plansDir, 0755)
		s.planFilePath = filepath.Join(plansDir, generatePlanID()+".md")
	}

	opts := types.RunOptions{
		Prompt:        text,
		ProjectPath:   s.config.WorkingDirectory,
		SessionID:     s.conversationID,
		MaxTokens:     s.config.MaxTokens,
		Thinking:      s.config.Thinking,
		PlanMode:      s.planMode,
		PlanModeTools: s.planModeTools,
		PlanFilePath:  s.planFilePath,
	}

	// Per-prompt overrides take precedence over session config
	if overrides != nil {
		if overrides.Model != "" {
			opts.Model = overrides.Model
		}
		if overrides.MaxTurns > 0 {
			opts.MaxTurns = overrides.MaxTurns
		}
		if overrides.MaxBudgetUsd > 0 {
			opts.MaxBudgetUsd = overrides.MaxBudgetUsd
		}
		if overrides.AppendSystemPrompt != "" {
			opts.AppendSystemPrompt += "\n\n" + overrides.AppendSystemPrompt
		}
	}

	// Inject system hint from session config
	if s.config.SystemHint != "" {
		opts.AppendSystemPrompt += "\n\n" + s.config.SystemHint
	}

	// Apply config defaults if session didn't specify
	if m.config != nil {
		if opts.Model == "" {
			opts.Model = m.config.DefaultModel
		}
		if opts.MaxTurns <= 0 && m.config.Limits.MaxTurns != nil {
			opts.MaxTurns = *m.config.Limits.MaxTurns
		}
		if opts.MaxBudgetUsd <= 0 && m.config.Limits.MaxBudgetUsd != nil {
			opts.MaxBudgetUsd = *m.config.Limits.MaxBudgetUsd
		}
		if opts.CompactThreshold <= 0 && m.config.Compaction != nil && m.config.Compaction.Threshold > 0 {
			opts.CompactThreshold = m.config.Compaction.Threshold
		}
	}

	// Resolve model tier aliases (e.g. "fast" -> configured fast model)
	if opts.Model != "" {
		if resolved := modelconfig.ResolveTier(opts.Model); resolved != opts.Model {
			opts.Model = resolved
		}
	}

	// Discover context files (CLAUDE.md, ION.md) from working directory
	var discoveredPaths []string
	if s.config.WorkingDirectory != "" {
		ctxFiles := ioncontext.WalkContextFiles(s.config.WorkingDirectory, ioncontext.IonPreset())
		var ctxContent strings.Builder
		for _, cf := range ctxFiles {
			ctxContent.WriteString("\n# Context from " + cf.Path + "\n")
			ctxContent.WriteString(cf.Content)
			ctxContent.WriteString("\n")
			discoveredPaths = append(discoveredPaths, cf.Path)
		}
		if ctxContent.Len() > 0 {
			opts.AppendSystemPrompt += ctxContent.String()
		}
	}

	// Fire context_inject hook for extension-provided context
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		injected := s.extGroup.FireContextInject(ctx, extension.ContextInjectInfo{
			WorkingDirectory: s.config.WorkingDirectory,
			DiscoveredPaths:  discoveredPaths,
		})
		for _, entry := range injected {
			opts.AppendSystemPrompt += "\n# " + entry.Label + "\n" + entry.Content + "\n"
		}

		// Inject capability tools and prompt content from all hosts
		for _, host := range s.extGroup.Hosts() {
			sdk := host.SDK()
			toolCaps := sdk.CapabilitiesByMode(extension.CapabilityModeTool)
			for _, cap := range toolCaps {
				capCopy := cap // capture for closure
				opts.CapabilityTools = append(opts.CapabilityTools, types.LlmToolDef{
					Name:        cap.ID,
					Description: cap.Description,
					InputSchema: cap.InputSchema,
				})
				_ = capCopy // used by execution routing (stored in registry)
			}
			promptCaps := sdk.CapabilitiesByMode(extension.CapabilityModePrompt)
			var capPrompt strings.Builder
			for _, cap := range promptCaps {
				capPrompt.WriteString("\n# Capability: " + cap.Name + "\n")
				capPrompt.WriteString(cap.Prompt)
				capPrompt.WriteString("\n")
			}
			if capPrompt.Len() > 0 {
				opts.CapabilityPrompt += capPrompt.String()
			}
		}
	}

	// Inject git context
	if s.config.WorkingDirectory != "" {
		if gitCtx := gitcontext.GetGitContext(s.config.WorkingDirectory); gitCtx != nil {
			if formatted := gitcontext.FormatForPrompt(gitCtx); formatted != "" {
				opts.AppendSystemPrompt += "\n\n" + formatted
			}
		}
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

	// Late-load extensions if per-prompt override provides them and session has none
	if overrides != nil && len(overrides.Extensions) > 0 && (s.extGroup == nil || s.extGroup.IsEmpty()) {
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
		if !group.IsEmpty() {
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
			group.FireSessionStart(ctx)
		}
	}

	// Determine whether to skip extension hooks for this prompt
	skipExtensions := overrides != nil && overrides.NoExtensions

	// Capture wired subsystems for hook wiring
	extGroup := s.extGroup
	permEng := s.permEngine
	telemCollector := s.telemetry
	mcpConns := s.mcpConns
	m.mu.Unlock()
	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: lock released", key))

	// Fire before_agent_start for primary system prompt injection
	// (outside lock -- hook response may include events that call m.emit)
	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: firing before_agent_start", key))
		basCtx := m.newExtContext(s, key)
		agentSysPrompt, _ := extGroup.FireBeforeAgentStart(basCtx, extension.AgentInfo{})
		if agentSysPrompt != "" {
			opts.AppendSystemPrompt += "\n\n" + agentSysPrompt
			utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: before_agent_start injected %d chars", key, len(agentSysPrompt)))
		}
	}

	// Clear any working message left by before_agent_start hook
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	// Fire model_select hook (outside lock -- hook may emit events)
	if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
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

	utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: building backend run config", key))

	// Build the per-run RunConfig that travels with this run on the backend.
	// Storing hooks/perm engine/external tools/agent spawner on each run --
	// rather than mutating shared state on the singleton ApiBackend --
	// guarantees that concurrent sessions cannot trample each other's
	// closures. Without this, two desktop tabs running in parallel would
	// see each other's extension context, MCP tools, and agent spawn rules.
	var runCfg *backend.RunConfig
	if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		runCfg = &backend.RunConfig{}

		// Wire permission engine
		if permEng != nil {
			runCfg.PermEngine = permEng
		}
		// Wire security config (opt-in features like secret redaction)
		if m.config != nil && m.config.Security != nil {
			runCfg.SecurityCfg = m.config.Security
		}

		// Wire extension hook callbacks
		if extGroup != nil && !extGroup.IsEmpty() && !skipExtensions {
			capturedRequestID := requestID
			ctx := m.newExtContext(s, key)
			ctx.GetContextUsage = func() *extension.ContextUsage {
				usage := apiBackend.GetContextUsage(capturedRequestID)
				if usage == nil {
					return nil
				}
				return &extension.ContextUsage{
					Percent: usage.Percent,
					Tokens:  usage.Tokens,
				}
			}

			capturedEnterprise := func() *types.EnterpriseConfig {
				if m.config != nil {
					return m.config.Enterprise
				}
				return nil
			}()
			runCfg.Hooks.OnToolCall = func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
				// G07: Enterprise tool restriction check
				if capturedEnterprise != nil && !ionconfig.IsToolAllowed(info.ToolName, capturedEnterprise) {
					return &backend.ToolCallResult{Block: true, Reason: "tool blocked by enterprise policy"}, nil
				}
				result, err := extGroup.FireToolCall(ctx, extension.ToolCallInfo{
					ToolName: info.ToolName,
					ToolID:   info.ToolID,
					Input:    info.Input,
				})
				if err != nil {
					return nil, err
				}
				if result != nil && result.Block {
					return &backend.ToolCallResult{Block: true, Reason: result.Reason}, nil
				}
				return nil, nil
			}

			runCfg.Hooks.OnPerToolHook = func(toolName string, info interface{}, phase string) (interface{}, error) {
				if phase == "before" {
					return extGroup.FirePerToolCall(ctx, toolName, info)
				}
				return extGroup.FirePerToolResult(ctx, toolName, info)
			}

			runCfg.Hooks.OnTurnStart = func(_ string, turnNum int) {
				extGroup.FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
			}
			runCfg.Hooks.OnTurnEnd = func(_ string, turnNum int) {
				extGroup.FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
			}

			runCfg.Hooks.OnBeforePrompt = func(_ string, prompt string) (string, string) {
				rewritten, sysPrompt, _ := extGroup.FireBeforePrompt(ctx, prompt)
				return rewritten, sysPrompt
			}

			runCfg.Hooks.OnPlanModePrompt = func(planFilePath string) (string, []string) {
				return extGroup.FirePlanModePrompt(ctx, planFilePath)
			}

			runCfg.Hooks.OnSessionBeforeCompact = func(_ string) bool {
				cancel, _ := extGroup.FireSessionBeforeCompact(ctx, extension.CompactionInfo{})
				return cancel
			}
			runCfg.Hooks.OnSessionCompact = func(_ string, info interface{}) {
				if ci, ok := info.(map[string]interface{}); ok {
					extGroup.FireSessionCompact(ctx, extension.CompactionInfo{
						Strategy:       fmt.Sprintf("%v", ci["strategy"]),
						MessagesBefore: toInt(ci["messagesBefore"]),
						MessagesAfter:  toInt(ci["messagesAfter"]),
					})
				}
			}

			runCfg.Hooks.OnPermissionRequest = func(_ string, info interface{}) {
				if pi, ok := info.(map[string]interface{}); ok {
					req := extension.PermissionRequestInfo{
						ToolName: fmt.Sprintf("%v", pi["tool_name"]),
						Input:    toStringMap(pi["input"]),
						Decision: fmt.Sprintf("%v", pi["decision"]),
					}
					if t, ok := pi["tier"].(string); ok {
						req.Tier = t
					}
					extGroup.FirePermissionRequest(ctx, req)
				}
			}
			runCfg.Hooks.OnPermissionDenied = func(_ string, info interface{}) {
				if pi, ok := info.(map[string]interface{}); ok {
					extGroup.FirePermissionDenied(ctx, extension.PermissionDeniedInfo{
						ToolName: fmt.Sprintf("%v", pi["tool_name"]),
						Input:    toStringMap(pi["input"]),
						Reason:   fmt.Sprintf("%v", pi["reason"]),
					})
				}
			}

			runCfg.Hooks.OnPermissionClassify = func(toolName string, input map[string]interface{}) string {
				return extGroup.FirePermissionClassify(ctx, extension.PermissionClassifyInfo{
					ToolName: toolName,
					Input:    input,
				})
			}

			runCfg.Hooks.OnFileChanged = func(_ string, path string, action string) {
				extGroup.FireFileChanged(ctx, extension.FileChangedInfo{Path: path, Action: action})
			}
		}

		// Wire telemetry adapter
		if telemCollector != nil {
			runCfg.Telemetry = &telemetryAdapter{c: telemCollector}
		}

		// Wire external tools (MCP + extension-registered)
		var combinedToolDefs []types.LlmToolDef
		var mcpRouter func(string, map[string]interface{}) (string, bool, error)

		// MCP tools
		if len(mcpConns) > 0 {
			for _, conn := range mcpConns {
				for _, tool := range conn.Tools() {
					combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
						Name:        "mcp__" + conn.Name() + "__" + tool.Name,
						Description: tool.Description,
						InputSchema: tool.InputSchema,
					})
				}
			}
			mcpRouter = func(fullName string, input map[string]interface{}) (string, bool, error) {
				parts := strings.SplitN(fullName, "__", 3)
				if len(parts) != 3 {
					return "", true, fmt.Errorf("invalid MCP tool name: %s", fullName)
				}
				serverName := parts[1]
				toolName := parts[2]
				for _, conn := range mcpConns {
					if conn.Name() == serverName {
						content, err := conn.CallTool(toolName, input)
						if err != nil {
							return "", true, err
						}
						return content, false, nil
					}
				}
				return "", true, fmt.Errorf("MCP server %q not connected", serverName)
			}
		}

		// Extension-registered tools
		if extGroup != nil && !extGroup.IsEmpty() {
			extTools := extGroup.Tools()
			utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: wiring %d extension tools", key, len(extTools)))
			for _, tool := range extTools {
				utils.Log("Session", fmt.Sprintf("SendPrompt[%s]:   tool: %s", key, tool.Name))
				combinedToolDefs = append(combinedToolDefs, types.LlmToolDef{
					Name:        tool.Name,
					Description: tool.Description,
					InputSchema: tool.Parameters,
				})
			}
		} else {
			utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: no extension tools (extGroup=%v)", key, extGroup != nil))
		}

		utils.Log("Session", fmt.Sprintf("SendPrompt[%s]: total external tools: %d", key, len(combinedToolDefs)))
		if len(combinedToolDefs) > 0 {
			capturedExtGroup := extGroup
			runCfg.ExternalTools = combinedToolDefs
			runCfg.McpToolRouter = func(name string, input map[string]interface{}) (string, bool, error) {
				// MCP tools (prefixed with mcp__)
				if mcpRouter != nil && strings.HasPrefix(name, "mcp__") {
					return mcpRouter(name, input)
				}
				// Extension-registered tools
				if capturedExtGroup != nil {
					for _, tool := range capturedExtGroup.Tools() {
						if tool.Name == name {
							ctx := m.newExtContext(s, key)
							result, err := tool.Execute(input, ctx)
							if err != nil {
								return err.Error(), true, nil
							}
							if result == nil {
								return "", false, nil
							}
							return result.Content, result.IsError, nil
						}
					}
				}
				return "", true, fmt.Errorf("external tool %q not found", name)
			}
		}

		// Wire agent spawner for Agent tool
		capturedModel := opts.Model
		capturedKey := key
		var agentCounter int
		runCfg.AgentSpawner = func(ctx context.Context, requestedName, prompt, description, cwd, model string) (string, error) {
			// If the LLM named a specialist, resolve it. Fires capability_match
			// when not registered so a harness extension can promote a draft
			// (via ctx.RegisterAgentSpec) and we resolve on the same call.
			var spec types.AgentSpec
			var specMatched bool
			if requestedName != "" {
				if matched, ok := m.resolveAgentSpec(s, key, requestedName); ok {
					spec = matched
					specMatched = true
				} else {
					return "", fmt.Errorf("agent %q is not registered (capability_match returned no match)", requestedName)
				}
			}
			m.mu.Lock()
			agentCounter++
			agentName := fmt.Sprintf("agent-%d", agentCounter)
			if specMatched {
				agentName = fmt.Sprintf("%s-%d", spec.Name, agentCounter)
			}
			displayName := description
			if displayName == "" {
				if specMatched && spec.Description != "" {
					displayName = spec.Description
				} else {
					displayName = agentName
					if len(prompt) > 60 {
						displayName = prompt[:60] + "..."
					} else if len(prompt) > 0 {
						displayName = prompt
					}
				}
				// Trim to first line for display
				if idx := strings.IndexByte(displayName, '\n'); idx > 0 {
					displayName = displayName[:idx]
				}
			}

			s.agentStates = append(s.agentStates, types.AgentStateUpdate{
				Name:   agentName,
				Status: "running",
				Metadata: map[string]interface{}{
					"displayName": displayName,
					"type":        "agent",
					"visibility":  "sticky",
					"invited":     true,
					"task":        prompt,
				},
			})
			snapshot := mergeAgentStates(s.lastExtAgentStates, s.agentStates)
			m.mu.Unlock()

			m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot})

			// Run child backend synchronously
			start := time.Now()
			child := backend.NewApiBackend()
			var result string
			var childErr error
			var childDone sync.WaitGroup
			childDone.Add(1)

			var childConvID string
			child.OnNormalized(func(_ string, ev types.NormalizedEvent) {
				if tc, ok := ev.Data.(*types.TaskCompleteEvent); ok {
					result = tc.Result
					childConvID = tc.SessionID
				}
			})
			child.OnExit(func(_ string, _ *int, _ *string, _ string) {
				childDone.Done()
			})
			child.OnError(func(_ string, err error) {
				childErr = err
			})

			// Use spec model if matched, then call-site model, then parent.
			childModel := model
			if childModel == "" && specMatched {
				childModel = spec.Model
			}
			if childModel == "" {
				childModel = capturedModel
			}
			childRequestID := fmt.Sprintf("%s-%s", capturedKey, agentName)
			runOpts := types.RunOptions{
				Prompt:      prompt,
				Model:       childModel,
				ProjectPath: cwd,
			}
			if specMatched {
				if spec.SystemPrompt != "" {
					runOpts.SystemPrompt = spec.SystemPrompt
				}
				if len(spec.Tools) > 0 {
					runOpts.AllowedTools = spec.Tools
				}
			}
			child.StartRun(childRequestID, runOpts)

			// Wait for child to finish OR parent context to cancel.
			// Without this select, the goroutine would block on childDone.Wait()
			// even after the parent run is interrupted.
			doneCh := make(chan struct{})
			go func() {
				childDone.Wait()
				close(doneCh)
			}()

			cancelled := false
			select {
			case <-doneCh:
				// Child finished naturally
			case <-ctx.Done():
				// Parent cancelled — cancel child too
				cancelled = true
				child.Cancel(childRequestID)
				<-doneCh // Wait for child to actually exit
			}

			elapsed := time.Since(start).Seconds()

			m.mu.Lock()
			for i := range s.agentStates {
				if s.agentStates[i].Name == agentName {
					if s.agentStates[i].Metadata == nil {
						s.agentStates[i].Metadata = map[string]interface{}{}
					}
					if cancelled {
						s.agentStates[i].Status = "cancelled"
					} else if childErr != nil {
						s.agentStates[i].Status = "error"
						s.agentStates[i].Metadata["lastWork"] = childErr.Error()
					} else {
						s.agentStates[i].Status = "done"
						if len(result) > 100 {
							s.agentStates[i].Metadata["lastWork"] = result[:100]
						} else {
							s.agentStates[i].Metadata["lastWork"] = result
						}
					}
					s.agentStates[i].Metadata["elapsed"] = elapsed
					if childConvID != "" {
						s.agentStates[i].Metadata["conversationId"] = childConvID
					}
					break
				}
			}
			snapshot2 := mergeAgentStates(s.lastExtAgentStates, s.agentStates)
			m.mu.Unlock()

			m.emit(capturedKey, types.EngineEvent{Type: "engine_agent_state", Agents: snapshot2})

			if cancelled {
				return "", ctx.Err()
			}
			if childErr != nil {
				return "", childErr
			}
			return result, nil
		}
	}

	// Wire permission hook settings for CLI backend
	if _, isCli := m.backend.(*backend.CliBackend); isCli && permEng != nil {
		hookServer, err := backend.NewPermissionHookServer(permEng)
		if err != nil {
			utils.Log("Session", "PermissionHookServer start failed: "+err.Error())
		} else {
			token := fmt.Sprintf("run-%d", time.Now().UnixMilli())
			hookServer.RegisterToken(token)

			// Wire permission forwarding: when hook server gets an "ask" decision,
			// emit engine_permission_request to desktop and block until response.
			hookServer.SetOnAsk(func(reqToken string, questionID string, toolName string, toolDesc string, toolInput map[string]any, options []types.PermissionOpt) chan string {
				ch := m.RegisterPendingPermission(key, questionID)
				if ch == nil {
					return nil
				}
				// Emit permission request as engine event
				m.emit(key, types.EngineEvent{
					Type:          "engine_permission_request",
					QuestionID:    questionID,
					PermToolName:  toolName,
					PermToolDesc:  toolDesc,
					PermToolInput: toolInput,
					PermOptions:   options,
				})
				// Return wrapped channel that cleans up after resolution
				result := make(chan string, 1)
				go func() {
					optionID := <-ch
					m.UnregisterPendingPermission(key, questionID)
					result <- optionID
				}()
				return result
			})

			settingsJSON := hookServer.GenerateSettingsJSON(token)

			// Write temp settings file
			tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ion-settings-%s.json", token))
			if err := os.WriteFile(tmpFile, settingsJSON, 0600); err != nil {
				utils.Log("Session", "failed to write hook settings: "+err.Error())
				hookServer.Close()
			} else {
				opts.HookSettingsPath = tmpFile
				utils.Log("Session", fmt.Sprintf("hook settings written to %s", tmpFile))
			}
		}
	}

	// Wire ToolServer for CLI backend when extensions provide tools
	if _, isCli := m.backend.(*backend.CliBackend); isCli && extGroup != nil && !extGroup.IsEmpty() {
		extTools := extGroup.Tools()
		if len(extTools) > 0 {
			ts := backend.NewToolServer(key)
			for _, tool := range extTools {
				capturedTool := tool
				ts.RegisterTool(capturedTool.Name, func(input map[string]interface{}) (*types.ToolResult, error) {
					ctx := m.newExtContext(s, key)
					return capturedTool.Execute(input, ctx)
				})
			}
			if err := ts.Start(); err != nil {
				utils.Log("Session", "ToolServer start failed: "+err.Error())
			} else {
				mcpPath, err := ts.McpConfigPath(key)
				if err != nil {
					utils.Log("Session", "ToolServer MCP config failed: "+err.Error())
					ts.Stop()
				} else {
					opts.McpConfig = mcpPath
					m.mu.Lock()
					s.toolServer = ts
					m.mu.Unlock()
					utils.Log("Session", fmt.Sprintf("ToolServer started for CLI backend (%d tools)", len(extTools)))
				}
			}
		}
	}

	// Apply extension-suppressed tools
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

// SendAbort cancels the active run for the given session and reaps any
// dispatched child agents so they do not continue running standalone.
func (m *Manager) SendAbort(key string) {
	utils.Info("Session", fmt.Sprintf("SendAbort: key=%s", key))
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Warn("Session", fmt.Sprintf("SendAbort: session not found for key=%s", key))
		return
	}
	rid := s.requestID
	m.mu.RUnlock()

	if rid != "" {
		utils.Info("Session", fmt.Sprintf("SendAbort: cancelling requestID=%s for key=%s", rid, key))
		m.backend.Cancel(rid)
	} else {
		utils.Warn("Session", fmt.Sprintf("SendAbort: no active requestID for key=%s (reaping descendants only)", key))
	}
	// Always reap descendants — they may outlive the parent run
	m.abortAllDescendants(key, "user abort")
}

// abortAllDescendants kills every agent registered for this session and
// clears the registry. Called when the parent run dies (error/non-zero
// exit) or the user interrupts so dispatched agents do not continue
// running standalone and burning model budget.
func (m *Manager) abortAllDescendants(key, reason string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return
	}
	var pids []int
	var names []string
	for name, handle := range s.agentRegistry {
		pids = append(pids, handle.PID)
		names = append(names, name)
	}
	s.agentRegistry = map[string]types.AgentHandle{}
	hasExt := s.extGroup != nil && !s.extGroup.IsEmpty()
	m.mu.Unlock()

	if len(pids) == 0 {
		return
	}
	utils.Warn("Session", fmt.Sprintf("aborting %d descendant agent(s) (%s): key=%s names=%v", len(pids), reason, key, names))
	for _, pid := range pids {
		killProcess(pid)
	}
	// Emit cleared agent state so the UI panel updates. Skip when the
	// session has an extension group — extensions own their agent panel
	// and will publish their own snapshot.
	if !hasExt {
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: []types.AgentStateUpdate{},
		})
	}
}

// handleHostDeath is invoked from a goroutine after the Host's reader loop
// detects the subprocess has died. It records whether a turn was in flight
// at the moment of death (so turn_aborted can fire on the new instance) and
// emits the typed engine_extension_died wire event. The actual respawn is
// deferred to handleRunExit when the active run finishes — never mid-turn.
func (m *Manager) handleHostDeath(key string, h *extension.Host) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}
	turnActive := s.requestID != ""
	m.mu.RUnlock()

	h.MarkTurnInFlight(turnActive)

	exitCode, signal := h.LastExit()
	utils.Warn("Session", fmt.Sprintf("extension subprocess died: key=%s ext=%s code=%v signal=%q turnActive=%v",
		key, h.Name(), exitCode, signal, turnActive))

	m.emit(key, types.EngineEvent{
		Type:          "engine_extension_died",
		ExtensionName: h.Name(),
		ExitCode:      exitCode,
		Signal:        &signal,
	})

	// Notify peers in the same session that a sibling died. Observational
	// only — peers can't prevent the death, but they can degrade
	// gracefully (mark dependent state as stale, etc.).
	m.firePeerExtensionDied(key, h, exitCode, signal)

	// If no run is active, respawn immediately. Otherwise the manager's
	// handleRunExit will call respawnDeadExtensions after the run ends.
	if !turnActive {
		m.respawnDeadExtensions(key)
	}
}

// respawnDeadExtensions iterates the session's extension group and
// respawns any host whose subprocess is dead. Called from handleRunExit
// after a run completes (so respawn never overlaps with an active turn).
// Each successful respawn fires extension_respawned (and turn_aborted, if
// the host died with a turn in flight) on the new instance and
// peer_extension_respawned on every other host in the group.
func (m *Manager) respawnDeadExtensions(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	for _, h := range hosts {
		if !h.Dead() {
			continue
		}

		prevExitCode, prevSignal := h.LastExit()
		hadTurnInFlight := h.TurnInFlightAtDeath()

		m.emit(key, types.EngineEvent{
			Type:   "engine_status",
			Fields: &types.StatusFields{Label: key, State: "extension_restarting"},
		})

		attempt, err := h.Respawn()
		if err != nil {
			if errors.Is(err, extension.ErrBudgetExceeded) {
				utils.Error("Session", fmt.Sprintf("extension respawn budget exceeded: key=%s ext=%s attempts=%d", key, h.Name(), attempt))
				m.emit(key, types.EngineEvent{
					Type:          "engine_extension_dead_permanent",
					ExtensionName: h.Name(),
					AttemptNumber: attempt,
				})
				continue
			}
			utils.Error("Session", fmt.Sprintf("extension respawn failed: key=%s ext=%s err=%v", key, h.Name(), err))
			m.emit(key, types.EngineEvent{
				Type:         "engine_error",
				EventMessage: fmt.Sprintf("extension %s respawn failed: %v", h.Name(), err),
				ErrorCode:    "extension_respawn_failed",
			})
			continue
		}

		utils.Info("Session", fmt.Sprintf("extension respawned: key=%s ext=%s attempt=%d", key, h.Name(), attempt))

		// Fire extension_respawned on the new instance so the harness
		// can rebuild caches.
		_ = h.SDK().FireExtensionRespawned(ctx, extension.ExtensionRespawnedInfo{
			AttemptNumber: attempt,
			PrevExitCode:  prevExitCode,
			PrevSignal:    prevSignal,
		})

		// If the prior instance died mid-turn, signal that the missed
		// turn lifecycle was interrupted. The harness can use this to
		// reset per-turn state it was tracking.
		if hadTurnInFlight {
			_ = h.SDK().FireTurnAborted(ctx, extension.TurnAbortedInfo{Reason: "extension_died"})
		}

		// Notify peers that the sibling came back.
		m.firePeerExtensionRespawned(key, h, attempt)

		m.emit(key, types.EngineEvent{
			Type:          "engine_extension_respawned",
			ExtensionName: h.Name(),
			AttemptNumber: attempt,
		})
	}

	// Settle status back to idle once all hosts have been processed.
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle"},
	})
}

// firePeerExtensionDied fires peer_extension_died on every Host in the
// group except the one that died.
func (m *Manager) firePeerExtensionDied(key string, dead *extension.Host, exitCode *int, signal string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	info := extension.PeerExtensionInfo{
		Name:     dead.Name(),
		ExitCode: exitCode,
		Signal:   signal,
	}
	for _, h := range hosts {
		if h == dead || h.Dead() {
			continue
		}
		_ = h.SDK().FirePeerExtensionDied(ctx, info)
	}
}

// firePeerExtensionRespawned fires peer_extension_respawned on every Host
// in the group except the one that just respawned.
func (m *Manager) firePeerExtensionRespawned(key string, respawned *extension.Host, attempt int) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.extGroup == nil {
		m.mu.RUnlock()
		return
	}
	hosts := s.extGroup.Hosts()
	ctx := m.newExtContext(s, key)
	m.mu.RUnlock()

	info := extension.PeerExtensionInfo{
		Name:          respawned.Name(),
		AttemptNumber: attempt,
	}
	for _, h := range hosts {
		if h == respawned || h.Dead() {
			continue
		}
		_ = h.SDK().FirePeerExtensionRespawned(ctx, info)
	}
}

// AbortAgent sends SIGTERM to the named agent process. If subtree is true,
// it walks the parentAgent chain to find all descendant agents and aborts them.
//
// Special case: if agentName is empty and subtree is true, every agent in
// the session is aborted. The user-facing interrupt button uses this when
// the parent run is already dead but dispatched children are still alive.
func (m *Manager) AbortAgent(key, agentName string, subtree bool) {
	if agentName == "" && subtree {
		m.abortAllDescendants(key, "user abort (all)")
		return
	}

	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}

	var pidsToKill []int

	if subtree {
		// Collect all agents whose parentAgent chain includes agentName
		for name, handle := range s.agentRegistry {
			if name == agentName || isDescendant(s.agentRegistry, name, agentName) {
				pidsToKill = append(pidsToKill, handle.PID)
			}
		}
	} else {
		if handle, exists := s.agentRegistry[agentName]; exists {
			pidsToKill = append(pidsToKill, handle.PID)
		}
	}
	m.mu.RUnlock()

	for _, pid := range pidsToKill {
		killProcess(pid)
	}
}

// SteerAgent sends a message to a running agent's stdin, or steers the main
// session loop if agentName is empty.
func (m *Manager) SteerAgent(key, agentName, message string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return
	}

	// If agentName is empty, steer the main session loop
	if agentName == "" {
		rid := s.requestID
		m.mu.RUnlock()
		if rid != "" {
			if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
				apiBackend.Steer(rid, message)
			} else {
				// CliBackend: write follow-up message over stdin pipe
				stdinMsg := map[string]interface{}{
					"type": "user",
					"message": map[string]interface{}{
						"role": "user",
						"content": []map[string]interface{}{
							{"type": "text", "text": message},
						},
					},
				}
				if err := m.backend.WriteToStdin(rid, stdinMsg); err != nil {
					utils.Log("Session", "steer via stdin failed: "+err.Error())
				}
			}
		}
		return
	}

	handle, exists := s.agentRegistry[agentName]
	m.mu.RUnlock()

	if !exists {
		return
	}
	if handle.StdinWrite != nil {
		handle.StdinWrite(message)
	}
}

// SendDialogResponse responds to a dialog prompt.
func (m *Manager) SendDialogResponse(key, dialogID string, value interface{}) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("dialog response for unknown session %s", key))
		return
	}

	ch, exists := s.pendingDialogs[dialogID]
	m.mu.RUnlock()

	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending dialog %s for session %s", dialogID, key))
		return
	}
	// Non-blocking send -- if nobody is waiting, drop silently.
	select {
	case ch <- value:
	default:
	}
}

// resolveAgentSpec resolves an agent name to a registered spec. If the name
// is not in the session's spec registry, fires the capability_match hook so
// extensions can promote a draft (typically via ctx.RegisterAgentSpec) and
// retries resolution on the same call. Returns (spec, true) on success, or
// (zero, false) when no match is registered after the hook runs.
func (m *Manager) resolveAgentSpec(s *engineSession, key, name string) (types.AgentSpec, bool) {
	m.mu.RLock()
	if spec, ok := s.agentSpecs[name]; ok {
		m.mu.RUnlock()
		return spec, true
	}
	m.mu.RUnlock()

	if s.extGroup == nil {
		return types.AgentSpec{}, false
	}

	known := make([]string, 0, len(s.agentSpecs))
	m.mu.RLock()
	for n := range s.agentSpecs {
		known = append(known, n)
	}
	m.mu.RUnlock()

	extCtx := m.newExtContext(s, key)
	for _, h := range s.extGroup.Hosts() {
		_ = h.SDK().FireCapabilityMatch(extCtx, extension.CapabilityMatchInfo{
			Input:        name,
			Capabilities: known,
		})
	}

	// Retry — handler may have called ctx.RegisterAgentSpec.
	m.mu.RLock()
	defer m.mu.RUnlock()
	spec, ok := s.agentSpecs[name]
	return spec, ok
}

// elicit raises an elicitation request: emits engine_elicitation_request to
// connected clients, fires the elicitation_request extension hook, and waits
// for whichever responds first. Returns (response, cancelled, error).
//
// Defaults: a 5-minute timeout caps the wait so a forgotten elicitation
// cannot wedge an extension forever. If both client and extension respond,
// the first reply wins; the second is dropped (non-blocking send).
func (m *Manager) elicit(s *engineSession, key string, info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	requestID := info.RequestID
	if requestID == "" {
		requestID = fmt.Sprintf("elicit-%d", time.Now().UnixNano())
		info.RequestID = requestID
	}

	ch := make(chan elicitReply, 1)
	m.mu.Lock()
	s.pendingElicit[requestID] = ch
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(s.pendingElicit, requestID)
		m.mu.Unlock()
	}()

	// Fan out to clients.
	m.emit(key, types.EngineEvent{
		Type:            "engine_elicitation_request",
		ElicitRequestID: requestID,
		ElicitSchema:    info.Schema,
		ElicitURL:       info.URL,
		ElicitMode:      info.Mode,
	})

	// Fire the extension hook in parallel — extensions can also reply.
	hookCh := make(chan elicitReply, 1)
	go func() {
		extCtx := m.newExtContext(s, key)
		if s.extGroup == nil {
			return
		}
		// Fan out to every host; first non-nil reply wins.
		for _, h := range s.extGroup.Hosts() {
			resp, err := h.SDK().FireElicitationRequest(extCtx, info)
			if err == nil && resp != nil {
				select {
				case hookCh <- elicitReply{response: resp}:
				default:
				}
				return
			}
		}
	}()

	const timeout = 5 * time.Minute
	select {
	case reply := <-ch:
		// Mirror the response back through the elicitation_result hook so
		// extensions that observe rather than reply still see the outcome.
		if s.extGroup != nil {
			s.extGroup.FireElicitationResult(m.newExtContext(s, key), extension.ElicitationResultInfo{
				RequestID: requestID,
				Response:  reply.response,
				Cancelled: reply.cancelled,
			})
		}
		return reply.response, reply.cancelled, nil
	case reply := <-hookCh:
		return reply.response, false, nil
	case <-time.After(timeout):
		return nil, true, fmt.Errorf("elicitation %s timed out", requestID)
	}
}

// HandleElicitationResponse resolves a pending elicitation from a client.
// Called by the server when an `elicitation_response` command is received.
func (m *Manager) HandleElicitationResponse(key, requestID string, response map[string]interface{}, cancelled bool) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("elicitation_response for unknown session %s", key))
		return
	}
	ch, exists := s.pendingElicit[requestID]
	m.mu.RUnlock()
	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending elicitation %s for session %s", requestID, key))
		return
	}
	select {
	case ch <- elicitReply{response: response, cancelled: cancelled}:
	default:
	}
}

// SendPermissionResponse resolves a pending permission request from the hook server.
func (m *Manager) SendPermissionResponse(key, questionID, optionID string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("permission response for unknown session %s", key))
		return
	}

	ch, exists := s.pendingPermissions[questionID]
	m.mu.RUnlock()

	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending permission %s for session %s", questionID, key))
		return
	}
	// Non-blocking send -- if nobody is waiting, drop silently.
	select {
	case ch <- optionID:
	default:
	}
}

// RegisterPendingPermission creates a channel for an in-flight permission request.
// Returns the channel the hook server should block on.
func (m *Manager) RegisterPendingPermission(key, questionID string) chan string {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return nil
	}
	ch := make(chan string, 1)
	s.pendingPermissions[questionID] = ch
	return ch
}

// UnregisterPendingPermission removes a pending permission entry.
func (m *Manager) UnregisterPendingPermission(key, questionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	if !ok {
		return
	}
	delete(s.pendingPermissions, questionID)
}

// SendCommand dispatches an internal command to a session.
func (m *Manager) SendCommand(key, command, args string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		return
	}

	// Check extension commands first
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		cmds := s.extGroup.Commands()
		if cmd, exists := cmds[command]; exists {
			ctx := m.newExtContext(s, key)
			err := cmd.Execute(args, ctx)
			if err == nil {
				m.emit(key, types.EngineEvent{
					Type:         "engine_command_result",
					EventMessage: "command executed: " + command,
				})
			}
			return
		}
	}

	switch command {
	case "compact":
		if s.conversationID != "" {
			conv, err := conversation.Load(s.conversationID, "")
			if err == nil {
				conversation.Compact(conv, 10)
				_ = conversation.Save(conv, "")
				utils.Log("Session", fmt.Sprintf("compacted session %s", key))
			}
		}
	case "export":
		if s.conversationID != "" {
			conv, err := conversation.Load(s.conversationID, "")
			if err == nil {
				format := "markdown"
				if args != "" {
					format = args
				}
				output, err := export.ExportSession(conv, export.Options{Format: format})
				if err == nil {
					m.emit(key, types.EngineEvent{
						Type:         "engine_export",
						EventMessage: output,
					})
				} else {
					utils.Log("Session", fmt.Sprintf("export failed for %s: %s", key, err))
				}
			}
		}
	default:
		utils.Log("Session", fmt.Sprintf("unknown command %s/%s (args: %s)", key, command, args))
	}
}

// ForkSession forks the session's conversation at the given message index.
func (m *Manager) ForkSession(key string, messageIndex int) (string, error) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q not found", key)
	}

	if s.conversationID == "" {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q has no conversation", key)
	}

	extGroup := s.extGroup
	m.mu.Unlock()

	// Fire session_before_fork hook -- cancellable.
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
		cancel, err := extGroup.FireSessionBeforeFork(ctx, extension.ForkInfo{
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
		if err != nil {
			return "", fmt.Errorf("session_before_fork hook error: %w", err)
		}
		if cancel {
			return "", fmt.Errorf("fork cancelled by session_before_fork hook")
		}
	}

	m.mu.Lock()
	s, ok = m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return "", fmt.Errorf("session %q not found", key)
	}

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		m.mu.Unlock()
		return "", fmt.Errorf("failed to load conversation: %w", err)
	}

	forked := conversation.ForkConversation(conv, messageIndex)

	newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
	newSession := &engineSession{
		key:           newKey,
		config:        s.config,
		conversationID: forked.ID,
		agentRegistry: make(map[string]types.AgentHandle),
		childPIDs:     make(map[int]struct{}),
		planMode:      s.planMode,
		planModeTools: s.planModeTools,
	}
	m.sessions[newKey] = newSession
	m.mu.Unlock()

	if err := conversation.Save(forked, ""); err != nil {
		utils.Log("Session", "failed to save forked conversation: "+err.Error())
	}

	// Fire session_fork hook after the fork succeeds.
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		extGroup.FireSessionFork(ctx, extension.ForkInfo{
			SourceSessionKey: key,
			NewSessionKey:    newKey,
			ForkMessageIndex: messageIndex,
		})
	}

	return newKey, nil
}

// BranchSession branches the conversation tree at the given entry ID.
func (m *Manager) BranchSession(key, entryID string) error {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("session %q not found", key)
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return fmt.Errorf("session %q has no conversation", key)
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.Branch(conv, entryID); err != nil {
		utils.Log("Session", "branch failed: "+err.Error())
		return nil
	}
	return conversation.Save(conv, "")
}

// NavigateSession moves the conversation tree pointer to the target entry.
func (m *Manager) NavigateSession(key, targetID string) error {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return fmt.Errorf("session %q not found", key)
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return fmt.Errorf("session %q has no conversation", key)
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		return fmt.Errorf("failed to load conversation: %w", err)
	}

	if _, err := conversation.NavigateTree(conv, targetID); err != nil {
		return err
	}
	return conversation.Save(conv, "")
}

// GetSessionTree returns the conversation tree for visualization.
func (m *Manager) GetSessionTree(key string) interface{} {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		return nil
	}
	sessionID := s.conversationID
	m.mu.RUnlock()

	if sessionID == "" {
		return nil
	}

	conv, err := conversation.Load(sessionID, "")
	if err != nil {
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: "failed to load session tree: " + err.Error(),
		})
		return nil
	}
	return conversation.GetTree(conv)
}

// SetPlanMode enables or disables plan mode for a session.
func (m *Manager) SetPlanMode(key string, enabled bool, allowedTools []string, source string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		utils.Debug("Session", fmt.Sprintf("SetPlanMode: session %q not found (not yet started?)", key))
		return
	}
	was := s.planMode
	s.planMode = enabled
	s.planModeTools = allowedTools
	if !enabled {
		s.planFilePath = ""
		s.planModePromptSent = false
	}
	utils.Info("PlanMode", fmt.Sprintf("key=%s enabled=%v was=%v source=%s tools=%v", key, enabled, was, source, allowedTools))
}

// generatePlanID returns a random hex string for plan file naming.
func generatePlanID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// StopSession cancels the active run and cleans up the session.
func (m *Manager) StopSession(key string) error {
	utils.Info("Session", fmt.Sprintf("StopSession: key=%s", key))
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", key)
	}

	// Cancel active run
	if s.requestID != "" {
		m.backend.Cancel(s.requestID)
		s.requestID = ""
	}

	// Drop pending prompts
	s.promptQueue = nil

	// Kill child PIDs
	for pid := range s.childPIDs {
		killProcess(pid)
	}


	// Capture subsystems before deleting session
	extGroup := s.extGroup
	mcpConns := s.mcpConns
	telemCollector := s.telemetry
	sessionRecorder := s.recorder
	toolServer := s.toolServer

	delete(m.sessions, key)
	m.mu.Unlock()

	// Cleanup outside lock
	if toolServer != nil {
		toolServer.Stop()
	}
	if extGroup != nil && !extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		extGroup.FireSessionEnd(ctx)
		extGroup.Close()
	}
	for _, conn := range mcpConns {
		conn.Close()
	}
	if telemCollector != nil {
		telemCollector.Flush()
	}
	if sessionRecorder != nil {
		sessionRecorder.Close()
	}

	m.emit(key, types.EngineEvent{Type: "engine_dead"})
	return nil
}

// StopByPrefix stops all sessions whose key starts with the given prefix.
func (m *Manager) StopByPrefix(prefix string) {
	m.mu.RLock()
	var keys []string
	for k := range m.sessions {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			keys = append(keys, k)
		}
	}
	m.mu.RUnlock()

	for _, k := range keys {
		_ = m.StopSession(k)
	}
}

// StopAll stops every active session.
func (m *Manager) StopAll() error {
	m.mu.RLock()
	keys := make([]string, 0, len(m.sessions))
	for k := range m.sessions {
		keys = append(keys, k)
	}
	m.mu.RUnlock()

	for _, k := range keys {
		_ = m.StopSession(k)
	}
	return nil
}

// IsRunning reports whether the named session has an active run.
func (m *Manager) IsRunning(key string) bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	s, ok := m.sessions[key]
	return ok && s.requestID != ""
}

// handleNormalizedEvent translates a NormalizedEvent into an EngineEvent
// and forwards it through the Manager's event callback.
func (m *Manager) handleNormalizedEvent(runID string, event types.NormalizedEvent) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}

	utils.Debug("Session", fmt.Sprintf("normalized event: key=%s runID=%s type=%T", key, runID, event.Data))

	contextWindow := conversation.DefaultContext

	ee := translateToEngineEvent(event, contextWindow)
	if ee.Type == "" {
		utils.Debug("Session", fmt.Sprintf("dropping unhandled normalized event type: %T", event.Data))
		return
	}
	m.emit(key, ee)

	// G34: Fire tool_start/tool_end extension hooks
	m.mu.RLock()
	s, sOk := m.sessions[key]
	m.mu.RUnlock()
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		switch e := event.Data.(type) {
		case *types.ToolCallEvent:
			s.extGroup.FireToolStart(ctx, extension.ToolStartInfo{
				ToolName: e.ToolName,
				ToolID:   e.ToolID,
			})
		case *types.ToolResultEvent:
			_ = e // suppress unused
			s.extGroup.FireToolEnd(ctx)
		}
	}

	// Fire on_error extension hook
	if sOk && s.extGroup != nil && !s.extGroup.IsEmpty() {
		if errEv, ok := event.Data.(*types.ErrorEvent); ok {
			errCtx := m.newExtContext(s, key)
			s.extGroup.FireOnError(errCtx, extension.ErrorInfo{
				Message:      errEv.ErrorMessage,
				ErrorCode:    errEv.ErrorCode,
				Category:     classifyErrorCategory(errEv.ErrorCode),
				Retryable:    errEv.Retryable,
				RetryAfterMs: errEv.RetryAfterMs,
				HttpStatus:   errEv.HttpStatus,
			})
		}
	}

	// TaskComplete also emits engine_message_end with usage
	if tc, ok := event.Data.(*types.TaskCompleteEvent); ok {
		var pct int
		if tc.Usage.InputTokens != nil {
			pct = *tc.Usage.InputTokens * 100 / contextWindow
			if pct > 100 {
				pct = 100
			}
		}
		m.emit(key, types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				InputTokens:    derefInt(tc.Usage.InputTokens),
				OutputTokens:   derefInt(tc.Usage.OutputTokens),
				ContextPercent: pct,
				Cost:           tc.CostUsd,
			},
		})
	}
}

// handleRunExit is called when a backend run exits.
func (m *Manager) handleRunExit(runID string, code *int, signal *string, sessionID string) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}

	codeStr, sigStr := "nil", "nil"
	if code != nil {
		codeStr = fmt.Sprintf("%d", *code)
	}
	if signal != nil {
		sigStr = *signal
	}
	utils.Info("Session", fmt.Sprintf("handleRunExit: key=%s runID=%s code=%s signal=%s sessionID=%s", key, runID, codeStr, sigStr, sessionID))

	var nextPrompt *pendingPrompt
	m.mu.Lock()
	if s, ok := m.sessions[key]; ok {
		s.requestID = ""
		s.agentStates = nil
		if sessionID != "" {
			s.conversationID = sessionID
		}
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	}
	m.mu.Unlock()

	// Clear engine-managed agent panel (Agent tool sub-agents).
	// Only emit if the session had built-in agent states; extension-managed
	// agents are owned by the extension and must not be wiped on run exit.
	m.mu.RLock()
	hasExtGroup := false
	if s, ok := m.sessions[key]; ok {
		hasExtGroup = s.extGroup != nil && !s.extGroup.IsEmpty()
	}
	m.mu.RUnlock()
	if !hasExtGroup {
		m.emit(key, types.EngineEvent{
			Type:   "engine_agent_state",
			Agents: []types.AgentStateUpdate{},
		})
	}

	// Clear any stale working message before transitioning to idle
	m.emit(key, types.EngineEvent{Type: "engine_working_message", EventMessage: ""})

	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle", SessionID: sessionID},
	})

	if (code != nil && *code != 0) || signal != nil {
		utils.Warn("Session", fmt.Sprintf("emitting engine_dead: key=%s code=%s signal=%s", key, codeStr, sigStr))
		m.abortAllDescendants(key, fmt.Sprintf("parent run exit code=%s signal=%s", codeStr, sigStr))
		m.emit(key, types.EngineEvent{
			Type:     "engine_dead",
			ExitCode: code,
			Signal:   signal,
		})
	}

	// Auto-respawn any extension hosts whose subprocess died during the
	// run. Now that the run has finished we can rebuild safely without
	// mid-turn hook interleaving.
	m.respawnDeadExtensions(key)

	// Dispatch queued prompt outside the lock
	if nextPrompt != nil {
		utils.Debug("Session", fmt.Sprintf("dispatching queued prompt: key=%s", key))
		go func() {
			var ov *PromptOverrides
			if nextPrompt.model != "" || nextPrompt.maxTurns > 0 || nextPrompt.maxBudgetUsd > 0 || len(nextPrompt.extensions) > 0 || nextPrompt.noExtensions {
				ov = &PromptOverrides{
					Model:        nextPrompt.model,
					MaxTurns:     nextPrompt.maxTurns,
					MaxBudgetUsd: nextPrompt.maxBudgetUsd,
					Extensions:   nextPrompt.extensions,
					NoExtensions: nextPrompt.noExtensions,
				}
			}
			if err := m.SendPrompt(key, nextPrompt.text, ov); err != nil {
				utils.Error("Session", "queued prompt failed: "+err.Error())
			}
		}()
	}
}

// handleRunError is called when a backend run encounters an error.
// The error event is already emitted by ApiBackend.emitError via the
// NormalizedEvent pipeline (with structured ProviderError fields). This
// callback exists for logging and potential future coordination.
func (m *Manager) handleRunError(runID string, err error) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}
	utils.Error("Session", fmt.Sprintf("handleRunError: key=%s runID=%s err=%s", key, runID, err.Error()))
	// Reap descendants so a dispatched child does not continue running
	// (and billing model time) after the parent loop has died.
	m.abortAllDescendants(key, fmt.Sprintf("parent run error: %s", err.Error()))
}

// keyForRun finds the session key that owns the given request ID.
func (m *Manager) keyForRun(runID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, s := range m.sessions {
		if s.requestID == runID {
			return s.key
		}
	}
	return ""
}

// mergeAgentStates combines extension-managed agent states with engine-managed
// agent states into a single snapshot for emission to clients.
func mergeAgentStates(extStates, engineStates []types.AgentStateUpdate) []types.AgentStateUpdate {
	merged := make([]types.AgentStateUpdate, 0, len(extStates)+len(engineStates))
	merged = append(merged, extStates...)
	merged = append(merged, engineStates...)
	return merged
}

// translateToEngineEvent converts a NormalizedEvent to an EngineEvent.
// classifyErrorCategory maps an error code to an extension ErrorCategory.
func classifyErrorCategory(code string) extension.ErrorCategory {
	switch code {
	case "rate_limit", "overloaded", "auth", "timeout", "network",
		"stale_connection", "invalid_model", "stream_truncated",
		"invalid_request", "prompt_too_long", "content_filter",
		"media_error", "pdf_error", "unknown":
		return extension.ErrorCategoryProvider
	default:
		return extension.ErrorCategoryProvider
	}
}

func translateToEngineEvent(event types.NormalizedEvent, contextWindow int) types.EngineEvent {
	if event.Data == nil {
		return types.EngineEvent{Type: "engine_error", EventMessage: "nil event data"}
	}

	switch e := event.Data.(type) {
	case *types.TextChunkEvent:
		return types.EngineEvent{Type: "engine_text_delta", TextDelta: e.Text}

	case *types.ToolCallEvent:
		return types.EngineEvent{Type: "engine_tool_start", ToolName: e.ToolName, ToolID: e.ToolID}

	case *types.ToolResultEvent:
		return types.EngineEvent{Type: "engine_tool_end", ToolName: "", ToolID: e.ToolID, ToolResult: e.Content, ToolIsError: e.IsError}

	case *types.TaskCompleteEvent:
		return types.EngineEvent{
			Type: "engine_status",
			Fields: &types.StatusFields{
				State:             "idle",
				SessionID:         e.SessionID,
				TotalCostUsd:      e.CostUsd,
				ContextWindow:     contextWindow,
				PermissionDenials: e.PermissionDenials,
			},
		}

	case *types.ErrorEvent:
		return types.EngineEvent{
			Type:          "engine_error",
			EventMessage:  e.ErrorMessage,
			ErrorCode:     e.ErrorCode,
			ErrorCategory: string(classifyErrorCategory(e.ErrorCode)),
			Retryable:     e.Retryable,
			RetryAfterMs:  e.RetryAfterMs,
			HttpStatus:    e.HttpStatus,
		}

	case *types.UsageEvent:
		var pct int
		if e.Usage.InputTokens != nil {
			window := contextWindow
			if window <= 0 {
				window = conversation.DefaultContext
			}
			pct = *e.Usage.InputTokens * 100 / window
			if pct > 100 {
				pct = 100
			}
		}
		return types.EngineEvent{
			Type: "engine_message_end",
			EndUsage: &types.MessageEndUsage{
				InputTokens:    derefInt(e.Usage.InputTokens),
				OutputTokens:   derefInt(e.Usage.OutputTokens),
				ContextPercent: pct,
			},
		}

	case *types.SessionDeadEvent:
		return types.EngineEvent{
			Type:       "engine_dead",
			ExitCode:   e.ExitCode,
			Signal:     e.Signal,
			StderrTail: e.StderrTail,
		}

	case *types.PermissionRequestEvent:
		return types.EngineEvent{
			Type:          "engine_permission_request",
			QuestionID:    e.QuestionID,
			PermToolName:  e.ToolName,
			PermToolDesc:  e.ToolDescription,
			PermToolInput: e.ToolInput,
			PermOptions:   e.Options,
		}

	case *types.PlanModeChangedEvent:
		return types.EngineEvent{
			Type:             "engine_plan_mode_changed",
			PlanModeEnabled:  e.Enabled,
			PlanModeFilePath: e.PlanFilePath,
		}

	case *types.StreamResetEvent:
		return types.EngineEvent{Type: "engine_stream_reset"}

	case *types.CompactingEvent:
		return types.EngineEvent{Type: "engine_compacting", CompactingActive: e.Active}

	default:
		return types.EngineEvent{}
	}
}

// isDescendant checks if agent is a descendant of ancestor in the agent registry.
func isDescendant(registry map[string]types.AgentHandle, agent, ancestor string) bool {
	visited := make(map[string]bool)
	current := agent
	for {
		handle, ok := registry[current]
		if !ok || handle.ParentAgent == "" {
			return false
		}
		if handle.ParentAgent == ancestor {
			return true
		}
		if visited[handle.ParentAgent] {
			return false // cycle protection
		}
		visited[current] = true
		current = handle.ParentAgent
	}
}

// killProcess sends SIGTERM to a process, then escalates to SIGKILL after 5s
// if the process is still alive.
func killProcess(pid int) {
	if pid <= 0 {
		return
	}
	p, err := findProcess(pid)
	if err != nil || p == nil {
		return
	}
	_ = p.Signal(signalTerm())
	// Escalate to SIGKILL after 5s if the process hasn't exited.
	go func() {
		time.Sleep(5 * time.Second)
		_ = p.Signal(signalKill())
	}()
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func toInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case float64:
		return int(n)
	default:
		return 0
	}
}

func toStringMap(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return nil
}

// telemetryAdapter wraps telemetry.Collector to satisfy backend.TelemetryCollector.
type telemetryAdapter struct {
	c *telemetry.Collector
}

func (a *telemetryAdapter) Event(name string, payload map[string]interface{}, ctx map[string]interface{}) {
	a.c.Event(name, payload, ctx)
}

func (a *telemetryAdapter) StartSpan(name string, attrs map[string]interface{}) backend.Span {
	return a.c.StartSpan(name, attrs)
}
