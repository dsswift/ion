// Package types defines the wire-compatible Go equivalents of the Ion Engine
// TypeScript types. JSON struct tags match the TypeScript field names exactly.
package types

import "encoding/json"

// RawEngineEvent is a pass-through JSON representation of an engine event.
// Use this when forwarding events without parsing (e.g., socket relay).
type RawEngineEvent = json.RawMessage

// --- Stream Event Types ---

// InitEvent is emitted once at the start of an engine session.
type InitEvent struct {
	Type              string          `json:"type"`
	Subtype           string          `json:"subtype"`
	Cwd               string          `json:"cwd"`
	SessionID         string          `json:"session_id"`
	Tools             []string        `json:"tools"`
	McpServers        []McpServerInfo `json:"mcp_servers"`
	Model             string          `json:"model"`
	PermissionMode    string          `json:"permissionMode"`
	Agents            []string        `json:"agents"`
	Skills            []string        `json:"skills"`
	Plugins           []string        `json:"plugins"`
	ClaudeCodeVersion string          `json:"claude_code_version"`
	FastModeState     string          `json:"fast_mode_state"`
	UUID              string          `json:"uuid"`
}

// McpServerInfo describes an MCP server and its connection status.
type McpServerInfo struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// StreamEvent wraps a streaming sub-event from the Claude API.
type StreamEvent struct {
	Type            string         `json:"type"`
	Event           StreamSubEvent `json:"event"`
	SessionID       string         `json:"session_id"`
	ParentToolUseID *string        `json:"parent_tool_use_id"`
	UUID            string         `json:"uuid"`
}

// StreamSubEvent is a discriminated union keyed on Type.
// Populate the fields relevant to the specific sub-event type.
type StreamSubEvent struct {
	Type         string                   `json:"type"`
	Message      *AssistantMessagePayload `json:"message,omitempty"`
	Index        *int                     `json:"index,omitempty"`
	ContentBlock *ContentBlock            `json:"content_block,omitempty"`
	Delta        *ContentDelta            `json:"delta,omitempty"`
	Usage        *UsageData               `json:"usage,omitempty"`
	// message_delta specific
	StopReason        *string `json:"stop_reason,omitempty"`
	ContextManagement any     `json:"context_management,omitempty"`
}

// ContentBlock is a text or tool_use block within a message.
type ContentBlock struct {
	Type  string         `json:"type"`
	Text  string         `json:"text,omitempty"`
	ID    string         `json:"id,omitempty"`
	Name  string         `json:"name,omitempty"`
	Input map[string]any `json:"input,omitempty"`
}

// ContentDelta carries incremental content updates.
type ContentDelta struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	PartialJSON string `json:"partial_json,omitempty"`
}

// AssistantEvent wraps a completed assistant message.
type AssistantEvent struct {
	Type            string                  `json:"type"`
	Message         AssistantMessagePayload `json:"message"`
	ParentToolUseID *string                 `json:"parent_tool_use_id"`
	SessionID       string                  `json:"session_id"`
	UUID            string                  `json:"uuid"`
}

// AssistantMessagePayload is the payload of an assistant turn.
type AssistantMessagePayload struct {
	Model      string         `json:"model"`
	ID         string         `json:"id"`
	Role       string         `json:"role"`
	Content    []ContentBlock `json:"content"`
	StopReason *string        `json:"stop_reason"`
	Usage      UsageData      `json:"usage"`
}

// RateLimitEvent signals a rate limit hit from the API.
type RateLimitEvent struct {
	Type          string        `json:"type"`
	RateLimitInfo RateLimitInfo `json:"rate_limit_info"`
	SessionID     string        `json:"session_id"`
	UUID          string        `json:"uuid"`
}

// RateLimitInfo contains details about the rate limit.
type RateLimitInfo struct {
	Status        string `json:"status"`
	ResetsAt      int64  `json:"resetsAt"`
	RateLimitType string `json:"rateLimitType"`
}

// ResultEvent signals completion (success or error) of a Claude run.
type ResultEvent struct {
	Type              string    `json:"type"`
	Subtype           string    `json:"subtype"`
	IsError           bool      `json:"is_error"`
	DurationMs        int64     `json:"duration_ms"`
	NumTurns          int       `json:"num_turns"`
	Result            string    `json:"result"`
	TotalCostUsd      float64   `json:"total_cost_usd"`
	SessionID         string    `json:"session_id"`
	Usage             UsageData `json:"usage"`
	PermissionDenials []PermissionDenialEntry `json:"permission_denials"`
	UUID              string    `json:"uuid"`
}

// UsageData tracks token usage for a message or session.
type UsageData struct {
	InputTokens              *int   `json:"input_tokens,omitempty"`
	OutputTokens             *int   `json:"output_tokens,omitempty"`
	CacheReadInputTokens     *int   `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens *int   `json:"cache_creation_input_tokens,omitempty"`
	ServiceTier              string `json:"service_tier,omitempty"`
}

// PermissionEvent requests user approval for a tool invocation.
type PermissionEvent struct {
	Type       string          `json:"type"`
	Tool       PermissionTool  `json:"tool"`
	QuestionID string          `json:"question_id"`
	Options    []PermissionOpt `json:"options"`
	SessionID  string          `json:"session_id"`
	UUID       string          `json:"uuid"`
}

// PermissionTool identifies the tool requesting permission.
type PermissionTool struct {
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Input       map[string]any `json:"input,omitempty"`
}

// PermissionOpt is one option in a permission prompt.
type PermissionOpt struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Kind  string `json:"kind,omitempty"`
}

// UnknownEvent captures any event type not explicitly modeled.
type UnknownEvent struct {
	Type   string         `json:"type"`
	Fields map[string]any `json:"-"`
}

// --- Message ---

// Message is a single entry in the conversation history.
type Message struct {
	ID               string `json:"id"`
	Role             string `json:"role"`
	Content          string `json:"content"`
	ToolName         string `json:"toolName,omitempty"`
	ToolInput        string `json:"toolInput,omitempty"`
	ToolID           string `json:"toolId,omitempty"`
	ToolStatus       string `json:"toolStatus,omitempty"`
	UserExecuted     bool   `json:"userExecuted,omitempty"`
	AutoExpandResult bool   `json:"autoExpandResult,omitempty"`
	Timestamp        int64  `json:"timestamp"`
}

// --- Engine Types ---

// EngineProfile defines an extension profile for the engine.
type EngineProfile struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

// EngineConfig configures a single engine session.
type EngineConfig struct {
	ProfileID        string            `json:"profileId"`
	Extensions       []string          `json:"extensions"`
	WorkingDirectory string            `json:"workingDirectory"`
	SessionID        string            `json:"sessionId,omitempty"`
	MaxTokens        int               `json:"maxTokens,omitempty"`
	Thinking         *ThinkingConfig   `json:"thinking,omitempty"`
	SystemHint       string            `json:"systemHint,omitempty"`
}

// ThinkingConfig controls extended thinking for API-backend runs.
type ThinkingConfig struct {
	Enabled      bool `json:"enabled"`
	BudgetTokens int  `json:"budgetTokens,omitempty"`
}

// EngineInstance identifies a running engine instance.
type EngineInstance struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// EnginePaneState tracks the set of engine instances and which is active.
type EnginePaneState struct {
	Instances        []EngineInstance `json:"instances"`
	ActiveInstanceID *string          `json:"activeInstanceId"`
}

// AgentStateUpdate describes the current state of an agent.
type AgentStateUpdate struct {
	Name     string                 `json:"name"`
	Status   string                 `json:"status"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
}

// AgentMessage is a single message within an agent's conversation.
type AgentMessage struct {
	Role     string `json:"role"`
	Content  string `json:"content"`
	ToolName string `json:"toolName,omitempty"`
}

// AgentHandle is a process registration handle for per-agent abort/steer.
type AgentHandle struct {
	PID         int
	StdinWrite  func(message string) bool
	ParentAgent string
}

// AgentSpec is an LLM-visible agent definition. Mirrors the markdown
// frontmatter shape (name, description, model, tools, parent, systemPrompt).
// Specs are registered at runtime via Context.RegisterAgentSpec so an
// extension's `capability_match` handler can promote a draft into a live,
// named specialist that the Agent tool can immediately dispatch.
type AgentSpec struct {
	Name         string   `json:"name"`
	Description  string   `json:"description,omitempty"`
	Model        string   `json:"model,omitempty"`
	Tools        []string `json:"tools,omitempty"`
	Parent       string   `json:"parent,omitempty"`
	SystemPrompt string   `json:"systemPrompt,omitempty"`
}

// StatusFields are the fields emitted by engine_status events.
type StatusFields struct {
	Label             string             `json:"label"`
	State             string             `json:"state"`
	SessionID         string             `json:"sessionId,omitempty"`
	Team              string             `json:"team,omitempty"`
	Model             string             `json:"model"`
	ContextPercent    int                `json:"contextPercent"`
	ContextWindow     int                `json:"contextWindow"`
	TotalCostUsd      float64            `json:"totalCostUsd,omitempty"`
	PermissionDenials []PermissionDenial `json:"permissionDenials,omitempty"`
	// ExtensionName is a friendly display name broadcast by the extension via
	// ext/emit engine_status. The engine preserves it across its own status
	// transitions so clients can show "Chief of Staff [idle]" instead of a
	// GUID compound key. Empty means no extension name was broadcast.
	ExtensionName string `json:"extensionName,omitempty"`
}

// --- Engine Events ---

// EngineEvent is a tagged union of all engine-emitted events.
// Populate the fields relevant to the specific Type.
type EngineEvent struct {
	Type string `json:"type"`

	// engine_agent_state
	Agents []AgentStateUpdate `json:"agents"`

	// engine_status
	Fields *StatusFields `json:"fields,omitempty"`

	// engine_working_message, engine_notify, engine_error, engine_harness_message
	EventMessage  string `json:"message,omitempty"`
	Level         string `json:"level,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
	ErrorCategory string `json:"errorCategory,omitempty"`
	Retryable     bool   `json:"retryable,omitempty"`
	RetryAfterMs  int64  `json:"retryAfterMs,omitempty"`
	HttpStatus    int    `json:"httpStatus,omitempty"`

	// engine_harness_message
	HarnessSource string `json:"source,omitempty"`

	// engine_dialog
	DialogID      string   `json:"dialogId,omitempty"`
	Method        string   `json:"method,omitempty"`
	Title         string   `json:"title,omitempty"`
	DialogOptions []string `json:"options,omitempty"`
	DefaultValue  string   `json:"defaultValue,omitempty"`

	// engine_text_delta
	TextDelta string `json:"text,omitempty"`

	// engine_message_end
	EndUsage *MessageEndUsage `json:"usage,omitempty"`

	// engine_tool_start
	ToolName string `json:"toolName,omitempty"`
	ToolID   string `json:"toolId,omitempty"`

	// engine_tool_end
	ToolResult  string `json:"result,omitempty"`
	ToolIsError bool   `json:"isError,omitempty"`

	// engine_dead
	ExitCode   *int     `json:"exitCode,omitempty"`
	Signal     *string  `json:"signal,omitempty"`
	StderrTail []string `json:"stderrTail,omitempty"`

	// engine_permission_request
	QuestionID      string          `json:"questionId,omitempty"`
	PermToolName    string          `json:"permToolName,omitempty"`
	PermToolDesc    string          `json:"permToolDescription,omitempty"`
	PermToolInput   map[string]any  `json:"permToolInput,omitempty"`
	PermOptions     []PermissionOpt `json:"permOptions,omitempty"`

	// engine_plan_mode_changed
	PlanModeEnabled  bool   `json:"planModeEnabled,omitempty"`
	PlanModeFilePath string `json:"planFilePath,omitempty"`

	// engine_compacting
	CompactingActive bool `json:"active,omitempty"`

	// engine_extension_died, engine_extension_respawned, engine_extension_dead_permanent
	ExtensionName string `json:"extensionName,omitempty"`
	AttemptNumber int    `json:"attemptNumber,omitempty"`

	// engine_elicitation_request, engine_elicitation_response
	// RequestID identifies the elicitation; clients echo it back via the
	// elicitation_response command. Schema, Url, and Mode describe what to
	// render. Response/Cancelled describe the user's reply (engine_elicitation_response).
	ElicitRequestID string                 `json:"requestId,omitempty"`
	ElicitSchema    map[string]interface{} `json:"schema,omitempty"`
	ElicitURL       string                 `json:"url,omitempty"`
	ElicitMode      string                 `json:"elicitMode,omitempty"`
	ElicitResponse  map[string]interface{} `json:"response,omitempty"`
	ElicitCancelled bool                   `json:"cancelled,omitempty"`
}

// MessageEndUsage reports token usage at the end of a message.
type MessageEndUsage struct {
	InputTokens    int     `json:"inputTokens"`
	OutputTokens   int     `json:"outputTokens"`
	ContextPercent int     `json:"contextPercent"`
	Cost           float64 `json:"cost"`
}

// --- Run Options ---

// RunOptions configures a Claude run.
type RunOptions struct {
	Prompt             string          `json:"prompt"`
	ProjectPath        string          `json:"projectPath"`
	SessionID          string          `json:"sessionId,omitempty"`
	AllowedTools       []string        `json:"allowedTools,omitempty"`
	SuppressTools      []string        `json:"suppressTools,omitempty"`
	MaxTurns           int             `json:"maxTurns,omitempty"`
	MaxBudgetUsd       float64         `json:"maxBudgetUsd,omitempty"`
	SystemPrompt       string          `json:"systemPrompt,omitempty"`
	Model              string          `json:"model,omitempty"`
	HookSettingsPath   string          `json:"hookSettingsPath,omitempty"`
	AddDirs            []string        `json:"addDirs,omitempty"`
	PermissionModeCli  string          `json:"permissionModeCli,omitempty"`
	AppendSystemPrompt string          `json:"appendSystemPrompt,omitempty"`
	Source             string          `json:"source,omitempty"`
	McpConfig          string          `json:"mcpConfig,omitempty"`
	MaxTokens          int             `json:"maxTokens,omitempty"`
	Thinking           *ThinkingConfig `json:"thinking,omitempty"`
	MaxRetries         int             `json:"maxRetries,omitempty"`
	FallbackModel      string          `json:"fallbackModel,omitempty"`
	Persistent         bool            `json:"persistent,omitempty"`
	PlanMode           bool            `json:"planMode,omitempty"`
	PlanModeTools      []string        `json:"planModeTools,omitempty"`
	PlanFilePath       string          `json:"planFilePath,omitempty"`
	PlanModePrompt     string          `json:"planModePrompt,omitempty"`
	CompactThreshold   float64         `json:"compactThreshold,omitempty"`
	CapabilityTools    []LlmToolDef    `json:"-"` // capability tools injected by session manager
	CapabilityPrompt   string          `json:"-"` // capability prompt content injected by session manager
}

// StoredSessionInfo is metadata for a saved conversation on disk.
type StoredSessionInfo struct {
	SessionID    string  `json:"sessionId"`
	Model        string  `json:"model"`
	CreatedAt    int64   `json:"createdAt"`
	MessageCount int     `json:"messageCount"`
	TotalCost    float64 `json:"totalCost"`
	FirstMessage string  `json:"firstMessage"`
	LastMessage  string  `json:"lastMessage"`
	CustomTitle  string  `json:"customTitle,omitempty"`
}

// SessionMessage is a flattened message for client display.
type SessionMessage struct {
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"toolName,omitempty"`
	ToolID    string `json:"toolId,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	Timestamp int64  `json:"timestamp"`
}

// PermissionDenialEntry is the wire format for permission denials in ResultEvent.
type PermissionDenialEntry struct {
	ToolName  string `json:"tool_name"`
	ToolUseID string `json:"tool_use_id"`
}

// PermissionDenial records a tool invocation that was denied.
// Wire format uses camelCase to match the desktop NormalizedEvent task_complete consumer.
type PermissionDenial struct {
	ToolName  string         `json:"toolName"`
	ToolUseID string         `json:"toolUseId"`
	ToolInput map[string]any `json:"toolInput,omitempty"`
}

// EnrichedError carries detailed context about a failed run.
type EnrichedError struct {
	Message              string             `json:"message"`
	StderrTail           []string           `json:"stderrTail"`
	StdoutTail           []string           `json:"stdoutTail,omitempty"`
	ExitCode             *int               `json:"exitCode"`
	ElapsedMs            int64              `json:"elapsedMs"`
	ToolCallCount        int                `json:"toolCallCount"`
	SawPermissionRequest bool               `json:"sawPermissionRequest,omitempty"`
	PermissionDenials    []PermissionDenial `json:"permissionDenials,omitempty"`
}
