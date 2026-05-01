package extension

import (
	"github.com/dsswift/ion/engine/internal/types"
)

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

// BeforePromptResult holds the optional overrides a before_prompt handler may return.
type BeforePromptResult struct {
	Prompt       string `json:"prompt,omitempty"`       // rewritten user prompt; empty means no change
	SystemPrompt string `json:"systemPrompt,omitempty"` // appended to system prompt; empty means no change
}

// PlanModePromptResult holds the optional overrides a plan_mode_prompt handler may return.
type PlanModePromptResult struct {
	Prompt string   `json:"prompt,omitempty"` // custom plan mode prompt; empty means use default
	Tools  []string `json:"tools,omitempty"`  // custom allowed tools; nil means use default
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
