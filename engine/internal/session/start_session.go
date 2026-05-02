package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/agentdiscovery"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/permissions"
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
				_ = childExtHost.FireSessionStart(childCtx)

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
					// Capture friendly extension name from extension-emitted status events
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
