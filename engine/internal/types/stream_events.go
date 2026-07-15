// Stream-event wire shapes consumed off the Anthropic streaming API.
//
// Extracted from types.go so the file-size cap leaves headroom for ongoing
// EngineEvent growth (the engine-event surface is where new events land
// over time; the stream-event surface here is stable and Anthropic-defined).
// JSON struct tags match the Anthropic field names verbatim (snake_case
// throughout) because these payloads are consumed directly off the SSE
// stream — not the engine's own wire protocol.
//
// Cross-language drift is not a concern for these structs: they are
// Anthropic-protocol payloads parsed engine-internally on the way to
// NormalizedEvent. They do not appear in the contract manifest under
// engine/internal/types/testdata/contracts.json (which tracks only the
// engine ↔ client wire). The fields listed here can evolve with Anthropic
// without requiring TS/Swift mirror changes.
package types

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
	Type              string                  `json:"type"`
	Subtype           string                  `json:"subtype"`
	IsError           bool                    `json:"is_error"`
	DurationMs        int64                   `json:"duration_ms"`
	NumTurns          int                     `json:"num_turns"`
	Result            string                  `json:"result"`
	TotalCostUsd      float64                 `json:"total_cost_usd"`
	SessionID         string                  `json:"session_id"`
	Usage             UsageData               `json:"usage"`
	PermissionDenials []PermissionDenialEntry `json:"permission_denials"`
	UUID              string                  `json:"uuid"`
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
