package session

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

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
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// pendingPrompt holds a queued prompt waiting for the active run to finish.
type pendingPrompt struct {
	text         string
	model        string
	maxTurns     int
	maxBudgetUsd float64
	extensionDir string
	noExtensions bool
}

// engineSession holds the state for a single session managed by the Manager.
type engineSession struct {
	key           string
	config        types.EngineConfig
	requestID     string // empty when no active run
	conversationID string
	agentRegistry map[string]types.AgentHandle
	childPIDs     map[int]struct{}
	planMode           bool
	planModeTools      []string
	planFilePath       string
	planModePromptSent bool
	promptQueue   []pendingPrompt
	maxQueueDepth int // default 32

	// Wired subsystems (populated in StartSession)
	extHost        *extension.Host
	mcpConns       []*mcp.Connection
	permEngine     *permissions.Engine
	telemetry      *telemetry.Collector
	recorder       *recorder.Recorder
	toolServer     *backend.ToolServer
	pendingDialogs     map[string]chan interface{}
	pendingPermissions map[string]chan string
	idleTimer          *time.Timer
	idleStop           chan struct{}
}

// SessionInfo describes a session in the list response.
type SessionInfo struct {
	Key          string `json:"key"`
	HasActiveRun bool   `json:"hasActiveRun"`
	ToolCount    int    `json:"toolCount"`
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
		if s.extHost != nil {
			toolCount = len(s.extHost.Tools())
		}
		// Count MCP tools
		for _, conn := range s.mcpConns {
			toolCount += len(conn.Tools())
		}
		result = append(result, SessionInfo{
			Key:          s.key,
			HasActiveRun: s.requestID != "",
			ToolCount:    toolCount,
		})
	}
	return result
}

// StartSession creates a new session with the given config.
func (m *Manager) StartSession(key string, config types.EngineConfig) error {
	utils.Info("Session", fmt.Sprintf("StartSession: key=%s model=%s dir=%s", key, config.Model, config.WorkingDirectory))
	m.mu.Lock()

	if _, exists := m.sessions[key]; exists {
		m.mu.Unlock()
		return fmt.Errorf("session %q already exists", key)
	}

	s := &engineSession{
		key:            key,
		config:         config,
		conversationID:  config.SessionID,
		agentRegistry:  make(map[string]types.AgentHandle),
		childPIDs:      make(map[int]struct{}),
		pendingDialogs:     make(map[string]chan interface{}),
		pendingPermissions: make(map[string]chan string),
		maxQueueDepth:  32,
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

	// G09: Idle timeout
	if m.config != nil && m.config.Limits.IdleTimeoutMs != nil && *m.config.Limits.IdleTimeoutMs > 0 {
		timeout := time.Duration(*m.config.Limits.IdleTimeoutMs) * time.Millisecond
		s.idleStop = make(chan struct{})
		s.idleTimer = time.AfterFunc(timeout, func() {
			// Guard: don't kill sessions with active runs (defense-in-depth)
			m.mu.RLock()
			sess, ok := m.sessions[key]
			isActive := ok && sess.requestID != ""
			m.mu.RUnlock()
			if isActive {
				m.mu.Lock()
				if sess, ok := m.sessions[key]; ok && sess.idleTimer != nil {
					sess.idleTimer.Reset(timeout)
				}
				m.mu.Unlock()
				return
			}
			utils.Log("Session", fmt.Sprintf("session %s idle timeout (%dms)", key, *m.config.Limits.IdleTimeoutMs))
			_ = m.StopSession(key)
		})
	}

	m.mu.Unlock()

	// Load extension if configured (outside lock -- subprocess may block)
	if config.ExtensionDir != "" {
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
			ExtensionDir:     config.ExtensionDir,
			Model:            config.Model,
			WorkingDirectory: config.WorkingDirectory,
			Options:          config.Options,
		}
		if err := host.Load(config.ExtensionDir, extCfg); err != nil {
			utils.Log("Session", "extension load failed: "+err.Error())
		} else {
			m.mu.Lock()
			s.extHost = host
			m.mu.Unlock()

			// Fire session_start
			ctx := &extension.Context{Cwd: config.WorkingDirectory}
			host.FireSessionStart(ctx)

			// Discover capabilities from extensions
			caps := host.FireCapabilityDiscover(ctx)
			for _, cap := range caps {
				host.SDK().RegisterCapability(cap)
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
	if m.config != nil {
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

	ctxWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(config.Model); info != nil {
		ctxWindow = info.ContextWindow
	}
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle", Model: config.Model, ContextWindow: ctxWindow},
	})

	return nil
}

// SendPrompt dispatches a prompt to the session's backend run.
// PromptOverrides holds per-prompt overrides from the client command.
type PromptOverrides struct {
	Model        string
	MaxTurns     int
	MaxBudgetUsd float64
	ExtensionDir string
	NoExtensions bool
}

func (m *Manager) SendPrompt(key, text string, overrides *PromptOverrides) error {
	m.mu.Lock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("session %q not found", key)
	}
	if s.requestID != "" {
		if len(s.promptQueue) >= s.maxQueueDepth {
			m.mu.Unlock()
			return fmt.Errorf("session %q prompt queue full (%d)", key, s.maxQueueDepth)
		}
		pp := pendingPrompt{text: text}
		if overrides != nil {
			pp.model = overrides.Model
			pp.maxTurns = overrides.MaxTurns
			pp.maxBudgetUsd = overrides.MaxBudgetUsd
			pp.extensionDir = overrides.ExtensionDir
			pp.noExtensions = overrides.NoExtensions
		}
		s.promptQueue = append(s.promptQueue, pp)
		utils.Log("Session", fmt.Sprintf("prompt queued for %s (%d in queue)", key, len(s.promptQueue)))
		m.mu.Unlock()
		return nil
	}

	requestID := fmt.Sprintf("%s-%d", key, time.Now().UnixMilli())
	s.requestID = requestID

	// Stop idle timer while run is active (restarted in handleRunExit)
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}

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
		Model:         s.config.Model,
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
	if s.extHost != nil {
		ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
		injected := s.extHost.FireContextInject(ctx, extension.ContextInjectInfo{
			WorkingDirectory: s.config.WorkingDirectory,
			DiscoveredPaths:  discoveredPaths,
		})
		for _, entry := range injected {
			opts.AppendSystemPrompt += "\n# " + entry.Label + "\n" + entry.Content + "\n"
		}

		// Inject capability tools and prompt content
		sdk := s.extHost.SDK()
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
			opts.CapabilityPrompt = capPrompt.String()
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

	// Late-load extension if per-prompt override provides one and session has none
	if overrides != nil && overrides.ExtensionDir != "" && s.extHost == nil {
		host := extension.NewHost()
		if m.config != nil && m.config.Enterprise != nil && len(m.config.Enterprise.RequiredHooks) > 0 {
			hooks := make([]struct{ Event, Handler string }, len(m.config.Enterprise.RequiredHooks))
			for i, h := range m.config.Enterprise.RequiredHooks {
				hooks[i] = struct{ Event, Handler string }{Event: h.Event, Handler: h.Handler}
			}
			host.RegisterRequiredHooks(hooks)
		}
		extCfg := &extension.ExtensionConfig{
			ExtensionDir:     overrides.ExtensionDir,
			Model:            s.config.Model,
			WorkingDirectory: s.config.WorkingDirectory,
			Options:          s.config.Options,
		}
		if err := host.Load(overrides.ExtensionDir, extCfg); err != nil {
			utils.Log("Session", "per-prompt extension load failed: "+err.Error())
		} else {
			s.extHost = host
			ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
			host.FireSessionStart(ctx)
		}
	}

	// Determine whether to skip extension hooks for this prompt
	skipExtensions := overrides != nil && overrides.NoExtensions

	// Capture wired subsystems for hook wiring
	extHost := s.extHost
	permEng := s.permEngine
	telemCollector := s.telemetry
	mcpConns := s.mcpConns
	m.mu.Unlock()

	// Wire ApiBackend hooks from session subsystems.
	// NOTE: Hooks are re-wired on every SendPrompt call (not just once in
	// StartSession) because the closures capture capturedRequestID, which
	// changes per prompt. The extension context's GetContextUsage callback
	// needs the current request ID to look up the active run. Moving this
	// to StartSession would require a different approach (e.g. an indirect
	// lookup via a mutable field) to resolve the current request ID.
	if apiBackend, ok := m.backend.(*backend.ApiBackend); ok {
		// Wire permission engine
		if permEng != nil {
			apiBackend.SetPermissions(permEng)
		}
		// Wire security config (opt-in features like secret redaction)
		if m.config != nil && m.config.Security != nil {
			apiBackend.SetSecurityConfig(m.config.Security)
		}

		// Wire extension hook callbacks
		if extHost != nil && !skipExtensions {
			capturedRequestID := requestID
			ctx := &extension.Context{
				Cwd: s.config.WorkingDirectory,
				GetContextUsage: func() *extension.ContextUsage {
					usage := apiBackend.GetContextUsage(capturedRequestID)
					if usage == nil {
						return nil
					}
					return &extension.ContextUsage{
						Percent: usage.Percent,
						Tokens:  usage.Tokens,
					}
				},
			}

			capturedEnterprise := func() *types.EnterpriseConfig {
				if m.config != nil {
					return m.config.Enterprise
				}
				return nil
			}()
			apiBackend.SetOnToolCall(func(info backend.ToolCallInfo) (*backend.ToolCallResult, error) {
				// G07: Enterprise tool restriction check
				if capturedEnterprise != nil && !ionconfig.IsToolAllowed(info.ToolName, capturedEnterprise) {
					return &backend.ToolCallResult{Block: true, Reason: "tool blocked by enterprise policy"}, nil
				}
				result, err := extHost.FireToolCall(ctx, extension.ToolCallInfo{
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
			})

			apiBackend.SetOnPerToolHook(func(toolName string, info interface{}, phase string) (interface{}, error) {
				if phase == "before" {
					return extHost.FirePerToolCall(ctx, toolName, info)
				}
				return extHost.FirePerToolResult(ctx, toolName, info)
			})

			apiBackend.SetTurnHooks(
				func(_ string, turnNum int) {
					extHost.SDK().FireTurnStart(ctx, extension.TurnInfo{TurnNumber: turnNum})
				},
				func(_ string, turnNum int) {
					extHost.SDK().FireTurnEnd(ctx, extension.TurnInfo{TurnNumber: turnNum})
				},
			)

			apiBackend.SetBeforePrompt(func(_ string, prompt string) (string, string) {
				rewritten, sysPrompt, _ := extHost.FireBeforePrompt(ctx, prompt)
				return rewritten, sysPrompt
			})

			apiBackend.SetPlanModePromptHook(func(planFilePath string) (string, []string) {
				return extHost.FirePlanModePrompt(ctx, planFilePath)
			})

			apiBackend.SetCompactionHooks(
				func(_ string) bool {
					cancel, _ := extHost.FireSessionBeforeCompact(ctx, extension.CompactionInfo{})
					return cancel
				},
				func(_ string, info interface{}) {
					if ci, ok := info.(map[string]interface{}); ok {
						extHost.SDK().FireSessionCompact(ctx, extension.CompactionInfo{
							Strategy:       fmt.Sprintf("%v", ci["strategy"]),
							MessagesBefore: toInt(ci["messagesBefore"]),
							MessagesAfter:  toInt(ci["messagesAfter"]),
						})
					}
				},
			)

			apiBackend.SetPermissionHooks(
				func(_ string, info interface{}) {
					if pi, ok := info.(map[string]interface{}); ok {
						extHost.SDK().FirePermissionRequest(ctx, extension.PermissionRequestInfo{
							ToolName: fmt.Sprintf("%v", pi["tool_name"]),
							Input:    toStringMap(pi["input"]),
							Decision: fmt.Sprintf("%v", pi["decision"]),
						})
					}
				},
				func(_ string, info interface{}) {
					if pi, ok := info.(map[string]interface{}); ok {
						extHost.SDK().FirePermissionDenied(ctx, extension.PermissionDeniedInfo{
							ToolName: fmt.Sprintf("%v", pi["tool_name"]),
							Input:    toStringMap(pi["input"]),
							Reason:   fmt.Sprintf("%v", pi["reason"]),
						})
					}
				},
			)

			apiBackend.SetFileChangedHook(func(_ string, path string, action string) {
				extHost.SDK().FireFileChanged(ctx, extension.FileChangedInfo{Path: path, Action: action})
			})
		}

		// Wire telemetry adapter
		if telemCollector != nil {
			apiBackend.SetTelemetry(&telemetryAdapter{c: telemCollector})
		}

		// Wire MCP tools
		if len(mcpConns) > 0 {
			var mcpToolDefs []types.LlmToolDef
			for _, conn := range mcpConns {
				for _, tool := range conn.Tools() {
					mcpToolDefs = append(mcpToolDefs, types.LlmToolDef{
						Name:        "mcp__" + conn.Name() + "__" + tool.Name,
						Description: tool.Description,
						InputSchema: tool.InputSchema,
					})
				}
			}

			mcpRouter := func(fullName string, input map[string]interface{}) (string, bool, error) {
				// Parse mcp__serverName__toolName
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

			apiBackend.SetExternalTools(mcpToolDefs, mcpRouter)
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
	if _, isCli := m.backend.(*backend.CliBackend); isCli && extHost != nil {
		extTools := extHost.Tools()
		if len(extTools) > 0 {
			ts := backend.NewToolServer(key)
			for _, tool := range extTools {
				capturedTool := tool
				ts.RegisterTool(capturedTool.Name, func(input map[string]interface{}) (*types.ToolResult, error) {
					ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
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

	utils.Info("Session", fmt.Sprintf("dispatching prompt: key=%s requestID=%s model=%s", key, requestID, opts.Model))
	promptCtxWindow := conversation.DefaultContext
	if info := providers.GetModelInfo(opts.Model); info != nil {
		promptCtxWindow = info.ContextWindow
	}
	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "running", Model: opts.Model, ContextWindow: promptCtxWindow},
	})

	m.backend.StartRun(requestID, opts)
	return nil
}

// SendAbort cancels the active run for the given session.
func (m *Manager) SendAbort(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok || s.requestID == "" {
		m.mu.RUnlock()
		return
	}
	rid := s.requestID
	m.mu.RUnlock()

	m.backend.Cancel(rid)
}

// AbortAgent sends SIGTERM to the named agent process. If subtree is true,
// it walks the parentAgent chain to find all descendant agents and aborts them.
func (m *Manager) AbortAgent(key, agentName string, subtree bool) {
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
	if s.extHost != nil {
		cmds := s.extHost.Commands()
		if cmd, exists := cmds[command]; exists {
			ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
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

	extHost := s.extHost
	cwd := s.config.WorkingDirectory
	m.mu.Unlock()

	// Fire session_before_fork hook -- cancellable.
	if extHost != nil {
		ctx := &extension.Context{Cwd: cwd}
		newKey := fmt.Sprintf("%s-fork-%d", key, time.Now().UnixMilli())
		cancel, err := extHost.FireSessionBeforeFork(ctx, extension.ForkInfo{
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
	if extHost != nil {
		ctx := &extension.Context{Cwd: cwd}
		extHost.SDK().FireSessionFork(ctx, extension.ForkInfo{
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
func (m *Manager) SetPlanMode(key string, enabled bool, allowedTools []string) {
	m.mu.Lock()
	defer m.mu.Unlock()

	s, ok := m.sessions[key]
	if !ok {
		utils.Debug("Session", fmt.Sprintf("SetPlanMode: session %q not found (not yet started?)", key))
		return
	}
	s.planMode = enabled
	s.planModeTools = allowedTools
	if !enabled {
		s.planFilePath = ""
		s.planModePromptSent = false
	}
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

	// Stop idle timer
	if s.idleTimer != nil {
		s.idleTimer.Stop()
	}

	// Capture subsystems before deleting session
	extHost := s.extHost
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
	if extHost != nil {
		ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
		extHost.FireSessionEnd(ctx)
		extHost.Dispose()
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

	m.mu.RLock()
	sess := m.sessions[key]
	m.mu.RUnlock()
	contextWindow := conversation.DefaultContext
	if sess != nil {
		if info := providers.GetModelInfo(sess.config.Model); info != nil {
			contextWindow = info.ContextWindow
		}
	}

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
	if sOk && s.extHost != nil {
		ctx := &extension.Context{Cwd: s.config.WorkingDirectory}
		switch e := event.Data.(type) {
		case *types.ToolCallEvent:
			s.extHost.SDK().FireToolStart(ctx, extension.ToolStartInfo{
				ToolName: e.ToolName,
				ToolID:   e.ToolID,
			})
		case *types.ToolResultEvent:
			_ = e // suppress unused
			s.extHost.SDK().FireToolEnd(ctx)
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
		if sessionID != "" {
			s.conversationID = sessionID
		}
		// Reset idle timer after run exit
		if s.idleTimer != nil && m.config != nil && m.config.Limits.IdleTimeoutMs != nil && *m.config.Limits.IdleTimeoutMs > 0 {
			s.idleTimer.Reset(time.Duration(*m.config.Limits.IdleTimeoutMs) * time.Millisecond)
		}
		if len(s.promptQueue) > 0 {
			next := s.promptQueue[0]
			s.promptQueue = s.promptQueue[1:]
			nextPrompt = &next
		}
	}
	m.mu.Unlock()

	m.emit(key, types.EngineEvent{
		Type:   "engine_status",
		Fields: &types.StatusFields{Label: key, State: "idle", SessionID: sessionID},
	})

	if (code != nil && *code != 0) || signal != nil {
		utils.Warn("Session", fmt.Sprintf("emitting engine_dead: key=%s code=%s signal=%s", key, codeStr, sigStr))
		m.emit(key, types.EngineEvent{
			Type:     "engine_dead",
			ExitCode: code,
			Signal:   signal,
		})
	}

	// Dispatch queued prompt outside the lock
	if nextPrompt != nil {
		utils.Debug("Session", fmt.Sprintf("dispatching queued prompt: key=%s", key))
		go func() {
			var ov *PromptOverrides
			if nextPrompt.model != "" || nextPrompt.maxTurns > 0 || nextPrompt.maxBudgetUsd > 0 || nextPrompt.extensionDir != "" || nextPrompt.noExtensions {
				ov = &PromptOverrides{
					Model:        nextPrompt.model,
					MaxTurns:     nextPrompt.maxTurns,
					MaxBudgetUsd: nextPrompt.maxBudgetUsd,
					ExtensionDir: nextPrompt.extensionDir,
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
func (m *Manager) handleRunError(runID string, err error) {
	key := m.keyForRun(runID)
	if key == "" {
		return
	}

	utils.Error("Session", fmt.Sprintf("handleRunError: key=%s runID=%s err=%s", key, runID, err.Error()))
	m.emit(key, types.EngineEvent{
		Type:         "engine_error",
		EventMessage: err.Error(),
	})
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

// translateToEngineEvent converts a NormalizedEvent to an EngineEvent.
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
		return types.EngineEvent{Type: "engine_error", EventMessage: e.ErrorMessage}

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
