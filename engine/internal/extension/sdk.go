// Package extension implements the Ion Engine extension SDK and host.
// Port of engine/src/extension-sdk.ts + extension-host.ts.
package extension

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Hook event names. 59 hooks across 15 categories.
const (
	// Lifecycle hooks
	HookSessionStart = "session_start"
	HookSessionEnd   = "session_end"
	HookBeforePrompt = "before_prompt"
	HookTurnStart    = "turn_start"
	HookTurnEnd      = "turn_end"
	HookMessageStart = "message_start"
	HookMessageEnd   = "message_end"
	HookToolStart    = "tool_start"
	HookToolEnd      = "tool_end"
	HookToolCall     = "tool_call"
	HookOnError      = "on_error"
	HookAgentStart   = "agent_start"
	HookAgentEnd     = "agent_end"

	// Session management hooks
	HookSessionBeforeCompact = "session_before_compact"
	HookSessionCompact       = "session_compact"
	HookSessionBeforeFork    = "session_before_fork"
	HookSessionFork          = "session_fork"
	HookSessionBeforeSwitch  = "session_before_switch"

	// Pre-action hooks
	HookBeforeAgentStart      = "before_agent_start"
	HookBeforeProviderRequest = "before_provider_request"

	// Content hooks
	HookContext       = "context"
	HookMessageUpdate = "message_update"
	HookToolResult    = "tool_result"
	HookInput         = "input"
	HookModelSelect   = "model_select"
	HookUserBash      = "user_bash"

	// Per-tool call hooks
	HookBashToolCall  = "bash_tool_call"
	HookReadToolCall  = "read_tool_call"
	HookWriteToolCall = "write_tool_call"
	HookEditToolCall  = "edit_tool_call"
	HookGrepToolCall  = "grep_tool_call"
	HookGlobToolCall  = "glob_tool_call"
	HookAgentToolCall = "agent_tool_call"

	// Per-tool result hooks
	HookBashToolResult  = "bash_tool_result"
	HookReadToolResult  = "read_tool_result"
	HookWriteToolResult = "write_tool_result"
	HookEditToolResult  = "edit_tool_result"
	HookGrepToolResult  = "grep_tool_result"
	HookGlobToolResult  = "glob_tool_result"
	HookAgentToolResult = "agent_tool_result"

	// Context discovery hooks
	HookContextDiscover = "context_discover"
	HookContextLoad     = "context_load"
	HookInstructionLoad = "instruction_load"

	// Permission hooks
	HookPermissionRequest  = "permission_request"
	HookPermissionDenied   = "permission_denied"
	HookPermissionClassify = "permission_classify"

	// File change hooks
	HookFileChanged = "file_changed"

	// Task lifecycle hooks
	HookTaskCreated   = "task_created"
	HookTaskCompleted = "task_completed"

	// Elicitation hooks
	HookElicitationRequest = "elicitation_request"
	HookElicitationResult  = "elicitation_result"

	// Plan mode hooks
	HookPlanModePrompt = "plan_mode_prompt"

	// Context injection hooks
	HookContextInject = "context_inject"

	// Capability framework hooks
	HookCapabilityDiscover = "capability_discover"
	HookCapabilityMatch    = "capability_match"
	HookCapabilityInvoke   = "capability_invoke"

	// Extension lifecycle hooks. Fire after the engine auto-respawns a
	// crashed extension subprocess (see Manager.respawnDeadExtensions).
	// Observational only — no return value affects engine behaviour.
	HookExtensionRespawned     = "extension_respawned"      // payload: {attemptNumber, prevExitCode, prevSignal}
	HookTurnAborted            = "turn_aborted"             // payload: {reason: "extension_died"}
	HookPeerExtensionDied      = "peer_extension_died"      // payload: {name, exitCode, signal}
	HookPeerExtensionRespawned = "peer_extension_respawned" // payload: {name, attemptNumber}
)

// HookHandler is a generic handler function.
// The ctx parameter carries session context.
// The payload is hook-specific data.
// Returns optional result (nil = no opinion) and error.
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)

// Context is the extension execution context passed to hook handlers.
type Context struct {
	// SessionKey identifies the engine session that fired the hook (the same
	// key clients pass on `start_session`/`send_prompt`). Empty when the
	// context does not originate from a live session (e.g. during extension
	// load before any session is bound). Extensions can use this as the key
	// of a module-level `Map` to keep per-session state across hook calls.
	SessionKey string

	Cwd    string
	Model  *ModelRef
	Config *ExtensionConfig

	// Event emission -- extensions emit typed data events, engine forwards to socket clients.
	Emit func(event types.EngineEvent)

	// Functional getters
	GetContextUsage func() *ContextUsage
	Abort           func()
	RegisterAgent   func(name string, handle types.AgentHandle)
	DeregisterAgent func(name string)
	ResolveTier     func(name string) string

	// RegisterAgentSpec registers an LLM-visible agent definition at runtime.
	// Used by capability_match hook handlers to promote a draft specialist
	// into a live agent the Agent tool can dispatch on the very next call.
	// Specs persist for the session's lifetime in memory; file persistence
	// is the harness's job.
	RegisterAgentSpec   func(spec types.AgentSpec)
	DeregisterAgentSpec func(name string)
	LookupAgentSpec     func(name string) (types.AgentSpec, bool)

	// Process lifecycle management for extension-spawned subprocesses.
	RegisterProcess     func(name string, pid int, task string) error
	DeregisterProcess   func(name string)
	ListProcesses       func() []ProcessInfo
	TerminateProcess    func(name string) error
	CleanStaleProcesses func() int

	// Agent discovery. Walks conventional directories for .md agent definitions
	// with configurable layer precedence. Harness engineers control which sources
	// are included and which layer overrides which.
	DiscoverAgents func(opts DiscoverAgentsOpts) (*DiscoverAgentsResult, error)

	// Tool suppression. Extensions call this during session_start to remove
	// built-in tools from the LLM's tool set for subsequent runs.
	SuppressTool func(name string)

	// CallTool dispatches an extension-initiated tool call through the
	// session's tool registry: built-in tools, MCP-registered tools, and
	// extension-registered tools (any host in the loaded group). Returns
	// (content, isError, error).
	//
	// Permissions: subject to the session's permission policy. "deny"
	// decisions resolve with `(content, true, nil)` carrying a human-readable
	// reason. "ask" decisions auto-deny with a clear message because
	// extension calls cannot block on user elicitation -- the harness must
	// configure an explicit allow rule for the specific tool/extension combo.
	//
	// Returns a non-nil Go error only for unknown-tool lookups (so the SDK
	// promise rejects on programming errors). Tool-internal failures resolve
	// as `(errorString, true, nil)`.
	//
	// Side effects: does NOT fire per-tool hooks (`bash_tool_call`, etc.) or
	// `permission_request`. Both would re-enter the calling extension and
	// create surprising recursion. Audit log entries from the permission
	// engine still fire.
	CallTool func(toolName string, input map[string]interface{}) (string, bool, error)

	// SendPrompt queues a fresh prompt on this session's agent loop. The
	// call returns once the engine has accepted (or rejected) the prompt;
	// it does NOT wait for the LLM to finish. `model` is an optional
	// per-prompt model override -- pass "" to use the session default.
	//
	// Slash commands and hook handlers can both call this. Common patterns:
	// `/cloud <message>` forces a remote model + sends the prompt;
	// `session_start` primes the agent with a kickoff prompt.
	//
	// Recursion hazard: a `before_prompt` handler that calls SendPrompt
	// triggers a new run, which fires `before_prompt` again. Unbounded
	// recursion is checked only by the engine's prompt queue depth -- the
	// extension is responsible for guarding its own loops (e.g. with a
	// per-session "in-flight" flag stored on a sessionKey-keyed Map).
	SendPrompt func(text string, model string) error

	// Engine-native agent dispatch. Creates a child session within the engine
	// with optional extension loading, system prompt injection, and event streaming.
	DispatchAgent func(opts DispatchAgentOpts) (*DispatchAgentResult, error)

	// Elicit raises an elicitation request that fans out to: (a) every
	// connected client as an engine_elicitation_request event for UI render,
	// and (b) the elicitation_request extension hook so other extensions can
	// observe or respond. The first non-nil reply wins. Returns the response
	// map and a cancelled flag. The harness owns the schema/url shape.
	Elicit func(info ElicitationRequestInfo) (map[string]interface{}, bool, error)
}

// DispatchAgentOpts configures an engine-native agent dispatch.
type DispatchAgentOpts struct {
	Name         string `json:"name"`
	Task         string `json:"task"`
	Model        string `json:"model,omitempty"`
	ExtensionDir string `json:"extensionDir,omitempty"`
	SystemPrompt string `json:"systemPrompt,omitempty"`
	ProjectPath  string `json:"projectPath,omitempty"`
	SessionID    string `json:"sessionId,omitempty"`

	// MaxTurns caps the child session's agent loop iteration count. <=0 (the
	// default when omitted) means unlimited -- the engine ships unopinionated.
	// Lets harness engineers fine-tune dispatched-agent budgets without
	// touching global engine config.
	MaxTurns int `json:"maxTurns,omitempty"`

	// OnEvent is called for each engine event emitted by the child session.
	// Not serialized -- set via the host when dispatching from an extension.
	OnEvent func(ev types.EngineEvent) `json:"-"`
}

// DispatchAgentResult holds the outcome of a dispatched agent.
type DispatchAgentResult struct {
	Output       string  `json:"output"`
	ExitCode     int     `json:"exitCode"`
	Elapsed      float64 `json:"elapsed"`
	Cost         float64 `json:"cost"`
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	SessionID    string  `json:"sessionId,omitempty"`
}

// DiscoverAgentsOpts configures which directories to scan for agent definitions
// and the override precedence. Directories are listed in precedence order:
// later entries override earlier entries with the same agent name (stem).
//
// Named sources:
//   "extension" -- {extensionDir}/agents/ (agents packaged with the extension)
//   "user"      -- ~/.ion/agents/ (user-level agents)
//   "project"   -- {workingDir}/.ion/agents/ (project-scoped agents)
//
// Example: ["extension", "user", "project"] means extension agents are defaults,
// user agents override them, project agents override both.
type DiscoverAgentsOpts struct {
	// Sources lists named agent sources in precedence order (later overrides earlier).
	// Valid values: "extension", "user", "project".
	// If empty, defaults to ["extension", "user", "project"].
	Sources []string `json:"sources,omitempty"`
	// ExtraDirs adds arbitrary directories to scan (appended after named sources).
	ExtraDirs []string `json:"extraDirs,omitempty"`
	// BundleName filters to a specific bundle subdirectory (e.g., "cloudops").
	// If empty, all bundles in each source directory are included.
	BundleName string `json:"bundleName,omitempty"`
	// Recursive walks subdirectories within each agent directory. Default true.
	Recursive *bool `json:"recursive,omitempty"`
}

// DiscoveredAgent represents a parsed agent definition returned to extensions.
type DiscoveredAgent struct {
	Name         string            `json:"name"`
	Path         string            `json:"path"`
	Source       string            `json:"source"` // "extension", "user", "project", or "extra"
	Parent       string            `json:"parent,omitempty"`
	Description  string            `json:"description,omitempty"`
	Model        string            `json:"model,omitempty"`
	Tools        []string          `json:"tools,omitempty"`
	SystemPrompt string            `json:"systemPrompt,omitempty"`
	Meta         map[string]string `json:"meta,omitempty"`
}

// DiscoverAgentsResult holds the discovered agents.
type DiscoverAgentsResult struct {
	Agents []DiscoveredAgent `json:"agents"`
}

// ModelRef identifies the active model and its context window.
type ModelRef struct {
	ID            string
	ContextWindow int
}

// ContextUsage reports current context window utilization.
type ContextUsage struct {
	Percent int
	Tokens  int
	Cost    float64
}

// ExtensionConfig carries configuration for an extension instance.
type ExtensionConfig struct {
	ExtensionDir     string                 `json:"extensionDir"`
	Model            string                 `json:"model,omitempty"`
	WorkingDirectory string                 `json:"workingDirectory"`
	McpConfigPath    string                 `json:"mcpConfigPath,omitempty"`
}

// ToolDefinition describes a tool registered by an extension.
type ToolDefinition struct {
	Name        string
	Description string
	Parameters  map[string]interface{}
	Execute     func(params interface{}, ctx *Context) (*types.ToolResult, error)
}

// CommandDefinition describes a slash command registered by an extension.
type CommandDefinition struct {
	Description string
	Execute     func(args string, ctx *Context) error
}

// --- Fire method payload types ---

// ToolCallInfo describes a tool invocation for the tool_call hook.
type ToolCallInfo struct {
	ToolName string                 `json:"toolName"`
	ToolID   string                 `json:"toolId"`
	Input    map[string]interface{} `json:"input"`
}

// ToolCallResult is the combined result of tool_call handlers.
type ToolCallResult struct {
	Block  bool   `json:"block"`
	Reason string `json:"reason,omitempty"`
}

// ToolStartInfo describes a tool starting for the tool_start hook.
type ToolStartInfo struct {
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
}

// ErrorCategory classifies engine errors.
type ErrorCategory string

const (
	ErrorCategoryTool       ErrorCategory = "tool_error"
	ErrorCategoryProvider   ErrorCategory = "provider_error"
	ErrorCategoryPermission ErrorCategory = "permission_error"
	ErrorCategoryMcp        ErrorCategory = "mcp_error"
	ErrorCategoryCompaction ErrorCategory = "compaction_error"
)

// ErrorInfo describes an error for the on_error hook.
type ErrorInfo struct {
	Message      string        `json:"message"`
	ErrorCode    string        `json:"errorCode,omitempty"`
	Category     ErrorCategory `json:"category,omitempty"`
	Retryable    bool          `json:"retryable,omitempty"`
	RetryAfterMs int64         `json:"retryAfterMs,omitempty"`
	HttpStatus   int           `json:"httpStatus,omitempty"`
}

// CompactionInfo describes a compaction event.
type CompactionInfo struct {
	Strategy       string `json:"strategy"`
	MessagesBefore int    `json:"messagesBefore"`
	MessagesAfter  int    `json:"messagesAfter"`
}

// ForkInfo describes a session fork event.
type ForkInfo struct {
	SourceSessionKey string `json:"sourceSessionKey"`
	NewSessionKey    string `json:"newSessionKey"`
	ForkMessageIndex int    `json:"forkMessageIndex"`
}

// PerToolCallResult is the combined result of per-tool call handlers.
type PerToolCallResult struct {
	Block  bool                   `json:"block"`
	Reason string                 `json:"reason,omitempty"`
	Mutate map[string]interface{} `json:"mutate,omitempty"`
}

// ContextDiscoverInfo describes a context file discovery event.
type ContextDiscoverInfo struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

// ContextLoadInfo describes a context file load event.
type ContextLoadInfo struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Source  string `json:"source"`
}

// ContextInjectInfo is the payload for the context_inject hook.
type ContextInjectInfo struct {
	WorkingDirectory string   `json:"workingDirectory"`
	DiscoveredPaths  []string `json:"discoveredPaths"`
}

// ContextEntry is a single piece of context content to inject into the system prompt.
type ContextEntry struct {
	Label   string `json:"label"`   // identifier shown in prompt (e.g. file path)
	Content string `json:"content"` // raw content to inject
}

// CapabilityMode controls how a capability is surfaced to the LLM.
type CapabilityMode int

const (
	CapabilityModeTool   CapabilityMode = 1 << iota // surface as LLM tool
	CapabilityModePrompt                            // inject into system prompt
)

// Capability is a registered behavior that can be discovered, presented, and invoked.
type Capability struct {
	ID          string                 // unique identifier
	Name        string                 // human-readable name
	Description string                 // one-line description
	Metadata    map[string]interface{} // extension-defined (triggers, tags, etc.)
	Mode        CapabilityMode         // how the engine surfaces this
	InputSchema map[string]interface{} // JSON Schema for tool parameters (Mode includes Tool)
	Execute     func(ctx *Context, input map[string]interface{}) (*types.ToolResult, error)
	Prompt      string // injected into system prompt (Mode includes Prompt)
}

// CapabilityMatchInfo is the payload for the capability_match hook.
type CapabilityMatchInfo struct {
	Input        string   `json:"input"`        // user's raw input
	Capabilities []string `json:"capabilities"` // all registered capability IDs
}

// CapabilityMatchResult describes which capabilities matched user input.
type CapabilityMatchResult struct {
	MatchedIDs []string               `json:"matchedIds"`     // capabilities to invoke
	Args       map[string]interface{} `json:"args,omitempty"` // arguments extracted from input
}

// MessageUpdateInfo describes a message update event.
type MessageUpdateInfo struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// PermissionRequestInfo carries details about a permission request.
type PermissionRequestInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
	Decision string                 `json:"decision"`
	RuleName string                 `json:"rule_name,omitempty"`
	// Tier is the classifier label assigned by the permission_classify hook
	// (or empty when no classifier ran). Lets audit/observation handlers
	// surface the harness's risk taxonomy alongside the engine's decision.
	Tier string `json:"tier,omitempty"`
}

// PermissionClassifyInfo carries the input to a permission_classify hook
// handler. Handlers return a tier label string ("SAFE", "HIGH", "CRITICAL"
// — any taxonomy your harness defines). The first non-empty label wins.
type PermissionClassifyInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
}

// PermissionDeniedInfo carries details about a denied permission.
type PermissionDeniedInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
	Reason   string                 `json:"reason"`
}

// FileChangedInfo carries details about a file change.
type FileChangedInfo struct {
	Path   string `json:"path"`
	Action string `json:"action"`
}

// TaskLifecycleInfo carries details about a task event.
type TaskLifecycleInfo struct {
	TaskID string                 `json:"task_id"`
	Name   string                 `json:"name,omitempty"`
	Status string                 `json:"status,omitempty"`
	Extra  map[string]interface{} `json:"extra,omitempty"`
}

// ElicitationRequestInfo carries details about an elicitation request.
type ElicitationRequestInfo struct {
	RequestID string                 `json:"request_id"`
	Schema    map[string]interface{} `json:"schema,omitempty"`
	URL       string                 `json:"url,omitempty"`
	Mode      string                 `json:"mode"`
}

// ElicitationResultInfo carries details about an elicitation result.
type ElicitationResultInfo struct {
	RequestID string                 `json:"request_id"`
	Response  map[string]interface{} `json:"response,omitempty"`
	Cancelled bool                   `json:"cancelled"`
}

// ModelSelectInfo describes a model selection event.
type ModelSelectInfo struct {
	RequestedModel  string   `json:"requestedModel"`
	AvailableModels []string `json:"availableModels,omitempty"`
}

// TurnInfo describes a turn lifecycle event.
type TurnInfo struct {
	TurnNumber int `json:"turnNumber"`
}

// AgentInfo describes an agent lifecycle event.
type AgentInfo struct {
	Name string `json:"name"`
	Task string `json:"task,omitempty"`
}

// BeforeAgentStartResult holds the optional overrides a before_agent_start handler may return.
type BeforeAgentStartResult struct {
	SystemPrompt string `json:"systemPrompt,omitempty"`
}

// SDK is the extension hook registry. It manages hook handlers, tools,
// commands, and capabilities registered by extensions.
type SDK struct {
	mu             sync.RWMutex
	hooks          map[string][]HookHandler
	tools          []ToolDefinition
	commands       map[string]CommandDefinition
	capabilities   map[string]Capability
	appendEntryFn  func(entryType string, data interface{}) error
}

// NewSDK creates a new extension SDK with empty registries.
func NewSDK() *SDK {
	return &SDK{
		hooks:        make(map[string][]HookHandler),
		commands:     make(map[string]CommandDefinition),
		capabilities: make(map[string]Capability),
	}
}

// On registers a handler for the given hook event.
func (s *SDK) On(event string, handler HookHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[event] = append(s.hooks[event], handler)
}

// PrependHook inserts a handler at the front of the hook chain for the given
// event. Used for enterprise required hooks that must run before extensions.
func (s *SDK) PrependHook(event string, handler HookHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hooks[event] = append([]HookHandler{handler}, s.hooks[event]...)
}

// RegisterTool adds a tool definition to the registry.
func (s *SDK) RegisterTool(def ToolDefinition) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tools = append(s.tools, def)
}

// RegisterCommand adds a slash command to the registry.
func (s *SDK) RegisterCommand(name string, def CommandDefinition) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commands[name] = def
}

// Tools returns all registered tool definitions.
func (s *SDK) Tools() []ToolDefinition {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ToolDefinition, len(s.tools))
	copy(out, s.tools)
	return out
}

// Commands returns all registered command definitions.
func (s *SDK) Commands() map[string]CommandDefinition {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]CommandDefinition, len(s.commands))
	for k, v := range s.commands {
		out[k] = v
	}
	return out
}

// AppendEntry adds a custom session entry via the active conversation.
// This allows extensions to inject entries (labels, custom data) into the session tree.
func (s *SDK) AppendEntry(entryType string, data interface{}) error {
	s.mu.RLock()
	fn := s.appendEntryFn
	s.mu.RUnlock()
	if fn == nil {
		return fmt.Errorf("appendEntry not available: no active session")
	}
	return fn(entryType, data)
}

// SetAppendEntryFn sets the function used by AppendEntry.
// Called by the session manager when a session is active.
func (s *SDK) SetAppendEntryFn(fn func(entryType string, data interface{}) error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.appendEntryFn = fn
}

// Handlers returns a snapshot of handlers for the given event.
func (s *SDK) Handlers(event string) []HookHandler {
	s.mu.RLock()
	defer s.mu.RUnlock()
	handlers := s.hooks[event]
	out := make([]HookHandler, len(handlers))
	copy(out, handlers)
	return out
}

// fire iterates all handlers for an event, logging errors without propagating.
// Returns all non-nil results.
func (s *SDK) fire(event string, ctx *Context, payload interface{}) []interface{} {
	handlers := s.Handlers(event)
	var results []interface{}
	for i, h := range handlers {
		result, err := h(ctx, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook %s handler[%d] error: %v", event, i, err))
			continue
		}
		if result != nil {
			results = append(results, result)
		}
	}
	return results
}

// --- Fire methods for each hook category ---

// FireSessionStart fires the session_start hook.
func (s *SDK) FireSessionStart(ctx *Context) error {
	s.fire(HookSessionStart, ctx, nil)
	return nil
}

// FireSessionEnd fires the session_end hook.
func (s *SDK) FireSessionEnd(ctx *Context) error {
	s.fire(HookSessionEnd, ctx, nil)
	return nil
}

// BeforePromptResult holds the optional overrides a before_prompt handler may return.
type BeforePromptResult struct {
	Prompt       string `json:"prompt,omitempty"`       // rewritten user prompt; empty means no change
	SystemPrompt string `json:"systemPrompt,omitempty"` // appended to system prompt; empty means no change
}

// FireBeforePrompt fires the before_prompt hook. Handlers may return a
// BeforePromptResult (with Prompt and/or SystemPrompt fields set), or a plain
// string (treated as a prompt rewrite for backward compatibility). The last
// non-nil result that provides each field wins.
// Returns the (possibly rewritten) prompt and an optional system prompt addition.
func (s *SDK) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	results := s.fire(HookBeforePrompt, ctx, prompt)
	outPrompt := prompt
	outSystem := ""
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case BeforePromptResult:
			if outPrompt == prompt && v.Prompt != "" {
				outPrompt = v.Prompt
			}
			if outSystem == "" && v.SystemPrompt != "" {
				outSystem = v.SystemPrompt
			}
		case *BeforePromptResult:
			if v != nil {
				if outPrompt == prompt && v.Prompt != "" {
					outPrompt = v.Prompt
				}
				if outSystem == "" && v.SystemPrompt != "" {
					outSystem = v.SystemPrompt
				}
			}
		case string:
			if outPrompt == prompt && v != "" {
				outPrompt = v
			}
		}
	}
	return outPrompt, outSystem, nil
}

// PlanModePromptResult holds the optional overrides a plan_mode_prompt handler may return.
type PlanModePromptResult struct {
	Prompt string   `json:"prompt,omitempty"` // custom plan mode prompt; empty means use default
	Tools  []string `json:"tools,omitempty"`  // custom allowed tools; nil means use default
}

// FirePlanModePrompt fires the plan_mode_prompt hook. Handlers may return a
// PlanModePromptResult with custom prompt and/or tool list. The last non-nil
// result wins. Returns the custom prompt (empty = use default) and tool list (nil = use default).
func (s *SDK) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string) {
	results := s.fire(HookPlanModePrompt, ctx, planFilePath)
	var outPrompt string
	var outTools []string
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case PlanModePromptResult:
			if outPrompt == "" && v.Prompt != "" {
				outPrompt = v.Prompt
			}
			if outTools == nil && v.Tools != nil {
				outTools = v.Tools
			}
		case *PlanModePromptResult:
			if v != nil {
				if outPrompt == "" && v.Prompt != "" {
					outPrompt = v.Prompt
				}
				if outTools == nil && v.Tools != nil {
					outTools = v.Tools
				}
			}
		case string:
			if outPrompt == "" && v != "" {
				outPrompt = v
			}
		}
	}
	return outPrompt, outTools
}

// FireTurnStart fires the turn_start hook.
func (s *SDK) FireTurnStart(ctx *Context, info TurnInfo) error {
	s.fire(HookTurnStart, ctx, info)
	return nil
}

// FireTurnEnd fires the turn_end hook.
func (s *SDK) FireTurnEnd(ctx *Context, info TurnInfo) error {
	s.fire(HookTurnEnd, ctx, info)
	return nil
}

// FireMessageStart fires the message_start hook.
func (s *SDK) FireMessageStart(ctx *Context) error {
	s.fire(HookMessageStart, ctx, nil)
	return nil
}

// FireMessageEnd fires the message_end hook.
func (s *SDK) FireMessageEnd(ctx *Context) error {
	s.fire(HookMessageEnd, ctx, nil)
	return nil
}

// FireMessageUpdate fires the message_update hook.
func (s *SDK) FireMessageUpdate(ctx *Context, info MessageUpdateInfo) error {
	s.fire(HookMessageUpdate, ctx, info)
	return nil
}

// FireToolCall fires the tool_call hook. If any handler returns a ToolCallResult
// with Block=true, the combined result blocks the call.
func (s *SDK) FireToolCall(ctx *Context, info ToolCallInfo) (*ToolCallResult, error) {
	results := s.fire(HookToolCall, ctx, info)
	for _, r := range results {
		if tcr, ok := r.(*ToolCallResult); ok && tcr.Block {
			return tcr, nil
		}
	}
	return nil, nil
}

// FireToolStart fires the tool_start hook.
func (s *SDK) FireToolStart(ctx *Context, info ToolStartInfo) error {
	s.fire(HookToolStart, ctx, info)
	return nil
}

// FireToolEnd fires the tool_end hook.
func (s *SDK) FireToolEnd(ctx *Context) error {
	s.fire(HookToolEnd, ctx, nil)
	return nil
}

// FireToolResult fires the tool_result hook.
func (s *SDK) FireToolResult(ctx *Context, info interface{}) error {
	s.fire(HookToolResult, ctx, info)
	return nil
}

// FireOnError fires the on_error hook.
func (s *SDK) FireOnError(ctx *Context, info ErrorInfo) error {
	s.fire(HookOnError, ctx, info)
	return nil
}

// FireAgentStart fires the agent_start hook.
func (s *SDK) FireAgentStart(ctx *Context, info AgentInfo) error {
	s.fire(HookAgentStart, ctx, info)
	return nil
}

// FireAgentEnd fires the agent_end hook.
func (s *SDK) FireAgentEnd(ctx *Context, info AgentInfo) error {
	s.fire(HookAgentEnd, ctx, info)
	return nil
}

// FireBeforeAgentStart fires the before_agent_start hook. Handlers may return
// a BeforeAgentStartResult with a SystemPrompt field, or a map with a
// "systemPrompt" key (for JSON-RPC subprocess extensions). The last non-empty
// system prompt wins.
func (s *SDK) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, error) {
	results := s.fire(HookBeforeAgentStart, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case BeforeAgentStartResult:
			if v.SystemPrompt != "" {
				return v.SystemPrompt, nil
			}
		case *BeforeAgentStartResult:
			if v != nil && v.SystemPrompt != "" {
				return v.SystemPrompt, nil
			}
		case map[string]interface{}:
			if sp, ok := v["systemPrompt"].(string); ok && sp != "" {
				return sp, nil
			}
		}
	}
	return "", nil
}

// FireSessionBeforeCompact fires the session_before_compact hook.
// If any handler returns true (as a bool), compaction is cancelled.
func (s *SDK) FireSessionBeforeCompact(ctx *Context, info CompactionInfo) (bool, error) {
	results := s.fire(HookSessionBeforeCompact, ctx, info)
	for _, r := range results {
		if cancel, ok := r.(bool); ok && cancel {
			return true, nil
		}
	}
	return false, nil
}

// FireSessionCompact fires the session_compact hook.
func (s *SDK) FireSessionCompact(ctx *Context, info CompactionInfo) error {
	s.fire(HookSessionCompact, ctx, info)
	return nil
}

// FireSessionBeforeFork fires the session_before_fork hook.
// If any handler returns true (as a bool), the fork is cancelled.
func (s *SDK) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	results := s.fire(HookSessionBeforeFork, ctx, info)
	for _, r := range results {
		if cancel, ok := r.(bool); ok && cancel {
			return true, nil
		}
	}
	return false, nil
}

// FireSessionFork fires the session_fork hook.
func (s *SDK) FireSessionFork(ctx *Context, info ForkInfo) error {
	s.fire(HookSessionFork, ctx, info)
	return nil
}

// FireSessionBeforeSwitch fires the session_before_switch hook.
func (s *SDK) FireSessionBeforeSwitch(ctx *Context) error {
	s.fire(HookSessionBeforeSwitch, ctx, nil)
	return nil
}

// FireBeforeProviderRequest fires the before_provider_request hook.
func (s *SDK) FireBeforeProviderRequest(ctx *Context, payload interface{}) error {
	s.fire(HookBeforeProviderRequest, ctx, payload)
	return nil
}

// FireContext fires the context hook.
func (s *SDK) FireContext(ctx *Context, payload interface{}) error {
	s.fire(HookContext, ctx, payload)
	return nil
}

// FireInput fires the input hook. Handlers may return a modified prompt;
// the last non-nil string result wins.
func (s *SDK) FireInput(ctx *Context, prompt string) (string, error) {
	results := s.fire(HookInput, ctx, prompt)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return prompt, nil
}

// FireModelSelect fires the model_select hook. Handlers may return a
// model ID string to override selection; the last non-nil result wins.
func (s *SDK) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	results := s.fire(HookModelSelect, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return info.RequestedModel, nil
}

// FireUserBash fires the user_bash hook.
func (s *SDK) FireUserBash(ctx *Context, command string) error {
	s.fire(HookUserBash, ctx, command)
	return nil
}

// FirePerToolCall fires a per-tool call hook (e.g., bash_tool_call).
// If any handler returns a PerToolCallResult with Block=true, the call is blocked.
func (s *SDK) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	hookName := toolName + "_tool_call"
	results := s.fire(hookName, ctx, info)
	for _, r := range results {
		if ptcr, ok := r.(*PerToolCallResult); ok && ptcr.Block {
			return ptcr, nil
		}
	}
	return nil, nil
}

// FirePerToolResult fires a per-tool result hook (e.g., bash_tool_result).
// If any handler returns a string, the content is modified; the last non-nil wins.
func (s *SDK) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	hookName := toolName + "_tool_result"
	results := s.fire(hookName, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, nil
		}
	}
	return "", nil
}

// FireContextDiscover fires the context_discover hook.
// If any handler returns true (as a bool), the context file is rejected.
func (s *SDK) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	results := s.fire(HookContextDiscover, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return true, nil
		}
	}
	return false, nil
}

// FireContextLoad fires the context_load hook.
// Handlers may return a modified content string or true (bool) to reject.
func (s *SDK) FireContextLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	results := s.fire(HookContextLoad, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return "", true, nil
		}
	}
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, false, nil
		}
	}
	return info.Content, false, nil
}

// FireInstructionLoad fires the instruction_load hook.
func (s *SDK) FireInstructionLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	results := s.fire(HookInstructionLoad, ctx, info)
	for _, r := range results {
		if reject, ok := r.(bool); ok && reject {
			return "", true, nil
		}
	}
	for i := len(results) - 1; i >= 0; i-- {
		if s, ok := results[i].(string); ok {
			return s, false, nil
		}
	}
	return info.Content, false, nil
}

// FirePermissionRequest fires the permission_request hook.
func (s *SDK) FirePermissionRequest(ctx *Context, info PermissionRequestInfo) {
	s.fire(HookPermissionRequest, ctx, info)
}

// FirePermissionClassify fires the permission_classify hook. Handlers return
// a tier label (string). The first non-empty label wins; if no handler
// returns one, an empty string is returned and the engine falls back to its
// built-in SAFE/UNSAFE classifier.
func (s *SDK) FirePermissionClassify(ctx *Context, info PermissionClassifyInfo) string {
	results := s.fire(HookPermissionClassify, ctx, info)
	for _, r := range results {
		switch v := r.(type) {
		case string:
			if v != "" {
				return v
			}
		case map[string]interface{}:
			if t, ok := v["tier"].(string); ok && t != "" {
				return t
			}
			if t, ok := v["value"].(string); ok && t != "" {
				return t
			}
		}
	}
	return ""
}

// FirePermissionDenied fires the permission_denied hook.
func (s *SDK) FirePermissionDenied(ctx *Context, info PermissionDeniedInfo) {
	s.fire(HookPermissionDenied, ctx, info)
}

// FireFileChanged fires the file_changed hook.
func (s *SDK) FireFileChanged(ctx *Context, info FileChangedInfo) {
	s.fire(HookFileChanged, ctx, info)
}

// FireTaskCreated fires the task_created hook.
func (s *SDK) FireTaskCreated(ctx *Context, info TaskLifecycleInfo) {
	s.fire(HookTaskCreated, ctx, info)
}

// FireTaskCompleted fires the task_completed hook.
func (s *SDK) FireTaskCompleted(ctx *Context, info TaskLifecycleInfo) {
	s.fire(HookTaskCompleted, ctx, info)
}

// FireElicitationRequest fires the elicitation_request hook.
// Returns the first non-nil response from handlers.
func (s *SDK) FireElicitationRequest(ctx *Context, info ElicitationRequestInfo) (map[string]interface{}, error) {
	results := s.fire(HookElicitationRequest, ctx, info)
	for _, r := range results {
		if m, ok := r.(map[string]interface{}); ok {
			return m, nil
		}
	}
	return nil, nil
}

// FireElicitationResult fires the elicitation_result hook.
func (s *SDK) FireElicitationResult(ctx *Context, info ElicitationResultInfo) {
	s.fire(HookElicitationResult, ctx, info)
}

// --- Context Inject ---

// FireContextInject fires the context_inject hook. Extensions return additional
// context entries to inject into the system prompt.
func (s *SDK) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	results := s.fire(HookContextInject, ctx, info)
	var entries []ContextEntry
	for _, r := range results {
		switch v := r.(type) {
		case []ContextEntry:
			entries = append(entries, v...)
		case ContextEntry:
			entries = append(entries, v)
		case []interface{}:
			for _, item := range v {
				if ce, ok := item.(ContextEntry); ok {
					entries = append(entries, ce)
				}
			}
		}
	}
	return entries
}

// --- Capability Registry ---

// RegisterCapability adds a capability to the registry.
func (s *SDK) RegisterCapability(cap Capability) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.capabilities[cap.ID] = cap
}

// UnregisterCapability removes a capability by ID.
func (s *SDK) UnregisterCapability(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.capabilities, id)
}

// Capabilities returns all registered capabilities.
func (s *SDK) Capabilities() []Capability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Capability, 0, len(s.capabilities))
	for _, cap := range s.capabilities {
		out = append(out, cap)
	}
	return out
}

// CapabilitiesByMode returns capabilities matching a mode flag.
func (s *SDK) CapabilitiesByMode(mode CapabilityMode) []Capability {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Capability
	for _, cap := range s.capabilities {
		if cap.Mode&mode != 0 {
			out = append(out, cap)
		}
	}
	return out
}

// --- Capability Hooks ---

// FireCapabilityDiscover fires the capability_discover hook. Extensions return
// capabilities to register. Called at session start.
func (s *SDK) FireCapabilityDiscover(ctx *Context) []Capability {
	results := s.fire(HookCapabilityDiscover, ctx, nil)
	var caps []Capability
	for _, r := range results {
		switch v := r.(type) {
		case []Capability:
			caps = append(caps, v...)
		case Capability:
			caps = append(caps, v)
		case []interface{}:
			for _, item := range v {
				if c, ok := item.(Capability); ok {
					caps = append(caps, c)
				}
			}
		}
	}
	return caps
}

// FireCapabilityMatch fires the capability_match hook. Extensions check if user
// input matches any registered capabilities and return matched IDs.
func (s *SDK) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	results := s.fire(HookCapabilityMatch, ctx, info)
	for i := len(results) - 1; i >= 0; i-- {
		switch v := results[i].(type) {
		case *CapabilityMatchResult:
			if v != nil && len(v.MatchedIDs) > 0 {
				return v
			}
		case CapabilityMatchResult:
			if len(v.MatchedIDs) > 0 {
				return &v
			}
		}
	}
	return nil
}

// FireCapabilityInvoke fires the capability_invoke hook before a capability
// is executed. Extensions can block or modify the invocation.
func (s *SDK) FireCapabilityInvoke(ctx *Context, capID string, input map[string]interface{}) (blocked bool, reason string) {
	type invokeInfo struct {
		CapabilityID string                 `json:"capability_id"`
		Input        map[string]interface{} `json:"input"`
	}
	results := s.fire(HookCapabilityInvoke, ctx, invokeInfo{CapabilityID: capID, Input: input})
	for _, r := range results {
		if tr, ok := r.(*ToolCallResult); ok && tr.Block {
			return true, tr.Reason
		}
	}
	return false, ""
}

// ExtensionRespawnedInfo carries the payload for the extension_respawned hook.
type ExtensionRespawnedInfo struct {
	AttemptNumber int    `json:"attemptNumber"`
	PrevExitCode  *int   `json:"prevExitCode,omitempty"`
	PrevSignal    string `json:"prevSignal,omitempty"`
}

// TurnAbortedInfo carries the payload for the turn_aborted hook.
type TurnAbortedInfo struct {
	Reason string `json:"reason"`
}

// PeerExtensionInfo carries the payload for peer_extension_died /
// peer_extension_respawned hooks. Reports the sibling that changed state.
type PeerExtensionInfo struct {
	Name          string `json:"name"`
	ExitCode      *int   `json:"exitCode,omitempty"`
	Signal        string `json:"signal,omitempty"`
	AttemptNumber int    `json:"attemptNumber,omitempty"`
}

// FireExtensionRespawned fires extension_respawned on the freshly-respawned
// instance after init handshake. Lets the harness rebuild caches or
// re-acquire resources lost when the prior subprocess died.
func (s *SDK) FireExtensionRespawned(ctx *Context, info ExtensionRespawnedInfo) error {
	s.fire(HookExtensionRespawned, ctx, info)
	return nil
}

// FireTurnAborted fires turn_aborted on the freshly-respawned instance when
// the prior subprocess died with a turn in flight. The new instance never
// saw the turn's hook lifecycle, so this signals that some hook fires were
// missed and any per-turn state should be reset.
func (s *SDK) FireTurnAborted(ctx *Context, info TurnAbortedInfo) error {
	s.fire(HookTurnAborted, ctx, info)
	return nil
}

// FirePeerExtensionDied fires peer_extension_died on every Host in the
// group except the one that actually died. Lets surviving extensions
// degrade gracefully when a sibling becomes unavailable.
func (s *SDK) FirePeerExtensionDied(ctx *Context, info PeerExtensionInfo) error {
	s.fire(HookPeerExtensionDied, ctx, info)
	return nil
}

// FirePeerExtensionRespawned fires peer_extension_respawned on every Host
// in the group except the one that just respawned. Lets surviving
// extensions re-establish coordination with the recovered sibling.
func (s *SDK) FirePeerExtensionRespawned(ctx *Context, info PeerExtensionInfo) error {
	s.fire(HookPeerExtensionRespawned, ctx, info)
	return nil
}
