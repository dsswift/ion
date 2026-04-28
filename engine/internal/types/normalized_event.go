package types

import (
	"encoding/json"
	"fmt"
)

// NormalizedEventType enumerates the canonical event kinds.
const (
	EventSessionInit       = "session_init"
	EventTextChunk         = "text_chunk"
	EventToolCall          = "tool_call"
	EventToolCallUpdate    = "tool_call_update"
	EventToolCallComplete  = "tool_call_complete"
	EventToolResult        = "tool_result"
	EventTaskUpdate        = "task_update"
	EventTaskComplete      = "task_complete"
	EventError             = "error"
	EventSessionDead       = "session_dead"
	EventRateLimit         = "rate_limit"
	EventUsage             = "usage"
	EventPermissionRequest = "permission_request"
	EventPlanModeChanged   = "plan_mode_changed"
	EventStreamReset       = "stream_reset"
	EventCompacting        = "compacting"
)

// NormalizedEventData is the interface satisfied by all canonical event variants.
type NormalizedEventData interface {
	eventType() string
}

// NormalizedEvent wraps a canonical event with its type discriminator.
// Custom JSON marshaling produces a flat JSON object with a "type" field.
type NormalizedEvent struct {
	Data NormalizedEventData
}

// MarshalJSON produces a flat JSON object with "type" merged into the variant fields.
func (e NormalizedEvent) MarshalJSON() ([]byte, error) {
	if e.Data == nil {
		return []byte("null"), nil
	}

	raw, err := json.Marshal(e.Data)
	if err != nil {
		return nil, err
	}

	// Unmarshal into a map, inject type, re-marshal.
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	m["type"] = e.Data.eventType()
	return json.Marshal(m)
}

// UnmarshalJSON reads the "type" field first, then decodes into the correct variant.
func (e *NormalizedEvent) UnmarshalJSON(data []byte) error {
	var peek struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &peek); err != nil {
		return err
	}

	var target NormalizedEventData
	switch peek.Type {
	case EventSessionInit:
		target = &SessionInitEvent{}
	case EventTextChunk:
		target = &TextChunkEvent{}
	case EventToolCall:
		target = &ToolCallEvent{}
	case EventToolCallUpdate:
		target = &ToolCallUpdateEvent{}
	case EventToolCallComplete:
		target = &ToolCallCompleteEvent{}
	case EventToolResult:
		target = &ToolResultEvent{}
	case EventTaskUpdate:
		target = &TaskUpdateEvent{}
	case EventTaskComplete:
		target = &TaskCompleteEvent{}
	case EventError:
		target = &ErrorEvent{}
	case EventSessionDead:
		target = &SessionDeadEvent{}
	case EventRateLimit:
		target = &RateLimitNormalizedEvent{}
	case EventUsage:
		target = &UsageEvent{}
	case EventPermissionRequest:
		target = &PermissionRequestEvent{}
	case EventPlanModeChanged:
		target = &PlanModeChangedEvent{}
	case EventStreamReset:
		target = &StreamResetEvent{}
	case EventCompacting:
		target = &CompactingEvent{}
	default:
		return fmt.Errorf("unknown normalized event type: %q", peek.Type)
	}

	if err := json.Unmarshal(data, target); err != nil {
		return err
	}
	e.Data = target
	return nil
}

// --- Concrete event types ---

// SessionInitEvent is emitted when an engine session initializes.
type SessionInitEvent struct {
	SessionID  string          `json:"sessionId"`
	Tools      []string        `json:"tools"`
	Model      string          `json:"model"`
	McpServers []McpServerInfo `json:"mcpServers"`
	Skills     []string        `json:"skills"`
	Version    string          `json:"version"`
	IsWarmup   bool            `json:"isWarmup,omitempty"`
}

func (SessionInitEvent) eventType() string { return EventSessionInit }

// TextChunkEvent carries a chunk of streamed text.
type TextChunkEvent struct {
	Text string `json:"text"`
}

func (TextChunkEvent) eventType() string { return EventTextChunk }

// ToolCallEvent signals the start of a tool invocation.
type ToolCallEvent struct {
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
	Index    int    `json:"index"`
}

func (ToolCallEvent) eventType() string { return EventToolCall }

// ToolCallUpdateEvent carries incremental input for a tool call.
type ToolCallUpdateEvent struct {
	ToolID       string `json:"toolId"`
	PartialInput string `json:"partialInput"`
}

func (ToolCallUpdateEvent) eventType() string { return EventToolCallUpdate }

// ToolCallCompleteEvent signals the end of tool input streaming.
type ToolCallCompleteEvent struct {
	Index int `json:"index"`
}

func (ToolCallCompleteEvent) eventType() string { return EventToolCallComplete }

// ToolResultEvent carries the output of a tool execution.
type ToolResultEvent struct {
	ToolID  string `json:"toolId"`
	Content string `json:"content"`
	IsError bool   `json:"isError"`
}

func (ToolResultEvent) eventType() string { return EventToolResult }

// TaskUpdateEvent carries an updated assistant message mid-stream.
type TaskUpdateEvent struct {
	Message AssistantMessagePayload `json:"message"`
}

func (TaskUpdateEvent) eventType() string { return EventTaskUpdate }

// TaskCompleteEvent signals the end of an engine run.
type TaskCompleteEvent struct {
	Result            string             `json:"result"`
	CostUsd           float64            `json:"costUsd"`
	DurationMs        int64              `json:"durationMs"`
	NumTurns          int                `json:"numTurns"`
	Usage             UsageData          `json:"usage"`
	SessionID         string             `json:"sessionId"`
	PermissionDenials []PermissionDenial `json:"permissionDenials,omitempty"`
}

func (TaskCompleteEvent) eventType() string { return EventTaskComplete }

// ErrorEvent signals an error during a run.
type ErrorEvent struct {
	ErrorMessage string `json:"message"`
	IsError      bool   `json:"isError"`
	SessionID    string `json:"sessionId,omitempty"`
	ErrorCode    string `json:"errorCode,omitempty"`
	Retryable    bool   `json:"retryable,omitempty"`
	RetryAfterMs int64  `json:"retryAfterMs,omitempty"`
	HttpStatus   int    `json:"httpStatus,omitempty"`
}

func (ErrorEvent) eventType() string { return EventError }

// SessionDeadEvent signals that the backend process exited.
type SessionDeadEvent struct {
	ExitCode   *int     `json:"exitCode"`
	Signal     *string  `json:"signal"`
	StderrTail []string `json:"stderrTail"`
}

func (SessionDeadEvent) eventType() string { return EventSessionDead }

// RateLimitNormalizedEvent signals a rate limit in canonical form.
type RateLimitNormalizedEvent struct {
	Status        string `json:"status"`
	ResetsAt      int64  `json:"resetsAt"`
	RateLimitType string `json:"rateLimitType"`
}

func (RateLimitNormalizedEvent) eventType() string { return EventRateLimit }

// UsageEvent carries a standalone usage update.
type UsageEvent struct {
	Usage UsageData `json:"usage"`
}

func (UsageEvent) eventType() string { return EventUsage }

// PermissionRequestEvent requests user approval for a tool call.
type PermissionRequestEvent struct {
	QuestionID      string          `json:"questionId"`
	ToolName        string          `json:"toolName"`
	ToolDescription string          `json:"toolDescription,omitempty"`
	ToolInput       map[string]any  `json:"toolInput,omitempty"`
	Options         []PermissionOpt `json:"options"`
}

func (PermissionRequestEvent) eventType() string { return EventPermissionRequest }

// WebSearchResultEvent carries results from a server-side web search.
type WebSearchResultEvent struct {
	Query   string         `json:"query"`
	Results []WebSearchHit `json:"results"`
}

// WebSearchHit is a single search result from a server-side web search.
type WebSearchHit struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}

func (WebSearchResultEvent) eventType() string { return "web_search_result" }

// PlanModeChangedEvent signals that the run has entered or exited plan mode.
type PlanModeChangedEvent struct {
	// Enabled is true when the run has entered plan mode, false when it has exited.
	Enabled      bool   `json:"enabled"`
	PlanFilePath string `json:"planFilePath,omitempty"`
}

func (PlanModeChangedEvent) eventType() string { return EventPlanModeChanged }

// StreamResetEvent signals that a retry is about to occur and the client
// should discard any partial assistant text from the previous attempt.
type StreamResetEvent struct{}

func (StreamResetEvent) eventType() string { return EventStreamReset }

// CompactingEvent signals that context compaction is starting or finishing.
// The desktop uses this to update the activity indicator ("Compacting...").
type CompactingEvent struct {
	Active bool `json:"active"`
}

func (CompactingEvent) eventType() string { return EventCompacting }
