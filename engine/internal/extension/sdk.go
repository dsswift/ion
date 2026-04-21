// Package extension implements the Ion Engine extension SDK and host.
// Port of engine/src/extension-sdk.ts + extension-host.ts.
package extension

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Hook event names. These correspond 1:1 with the TypeScript SDK's 43 hooks.
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
	HookPermissionRequest = "permission_request"
	HookPermissionDenied  = "permission_denied"

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
)

// HookHandler is a generic handler function.
// The ctx parameter carries session context.
// The payload is hook-specific data.
// Returns optional result (nil = no opinion) and error.
type HookHandler func(ctx *Context, payload interface{}) (interface{}, error)

// Context is the extension execution context passed to hook handlers.
type Context struct {
	Cwd    string
	Model  *ModelRef
	Config *ExtensionConfig
	UI     UI

	// Functional getters
	GetContextUsage func() *ContextUsage
	Abort           func()
	RegisterAgent   func(name string, handle types.AgentHandle)
	DeregisterAgent func(name string)
	ResolveTier     func(name string) string
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
	ExtensionDir     string
	Model            string
	WorkingDirectory string
	McpConfigPath    string
	Options          map[string]interface{}
}

// UI provides dialog primitives for extensions to interact with the user.
type UI interface {
	SetAgentStates(agents []types.AgentStateUpdate)
	SetStatus(fields types.StatusFields)
	SetWorkingMessage(message string)
	Notify(message string, level string)
	Select(title string, options []string) (string, error)
	Confirm(title string, message string, timeout int) (bool, error)
	Input(title string, placeholder string) (string, error)
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
	ToolName string
	ToolID   string
	Input    map[string]interface{}
}

// ToolCallResult is the combined result of tool_call handlers.
type ToolCallResult struct {
	Block  bool
	Reason string
}

// ToolStartInfo describes a tool starting for the tool_start hook.
type ToolStartInfo struct {
	ToolName string
	ToolID   string
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
	Message      string
	ErrorCode    string
	Category     ErrorCategory
	Retryable    bool
	RetryAfterMs int64
	HttpStatus   int
}

// CompactionInfo describes a compaction event.
type CompactionInfo struct {
	Strategy      string
	MessagesBefore int
	MessagesAfter  int
}

// ForkInfo describes a session fork event.
type ForkInfo struct {
	SourceSessionKey string
	NewSessionKey    string
	ForkMessageIndex int
}

// PerToolCallResult is the combined result of per-tool call handlers.
type PerToolCallResult struct {
	Block  bool
	Reason string
	Mutate map[string]interface{}
}

// ContextDiscoverInfo describes a context file discovery event.
type ContextDiscoverInfo struct {
	Path   string
	Source string
}

// ContextLoadInfo describes a context file load event.
type ContextLoadInfo struct {
	Path    string
	Content string
	Source  string
}

// ContextInjectInfo is the payload for the context_inject hook.
type ContextInjectInfo struct {
	WorkingDirectory string
	DiscoveredPaths  []string
}

// ContextEntry is a single piece of context content to inject into the system prompt.
type ContextEntry struct {
	Label   string // identifier shown in prompt (e.g. file path)
	Content string // raw content to inject
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
	Input        string   // user's raw input
	Capabilities []string // all registered capability IDs
}

// CapabilityMatchResult describes which capabilities matched user input.
type CapabilityMatchResult struct {
	MatchedIDs []string               // capabilities to invoke
	Args       map[string]interface{} // arguments extracted from input
}

// MessageUpdateInfo describes a message update event.
type MessageUpdateInfo struct {
	Role    string
	Content string
}

// PermissionRequestInfo carries details about a permission request.
type PermissionRequestInfo struct {
	ToolName string                 `json:"tool_name"`
	Input    map[string]interface{} `json:"input"`
	Decision string                 `json:"decision"`
	RuleName string                 `json:"rule_name,omitempty"`
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
	RequestedModel string
	AvailableModels []string
}

// TurnInfo describes a turn lifecycle event.
type TurnInfo struct {
	TurnNumber int
}

// AgentInfo describes an agent lifecycle event.
type AgentInfo struct {
	Name string
	Task string
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
	Prompt       string // rewritten user prompt; empty means no change
	SystemPrompt string // appended to system prompt; empty means no change
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
	Prompt string   // custom plan mode prompt; empty means use default
	Tools  []string // custom allowed tools; nil means use default
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

// FireBeforeAgentStart fires the before_agent_start hook.
func (s *SDK) FireBeforeAgentStart(ctx *Context, info AgentInfo) error {
	s.fire(HookBeforeAgentStart, ctx, info)
	return nil
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
