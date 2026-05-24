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
	EventPlanProposal      = "plan_proposal"
	EventStreamReset       = "stream_reset"
	EventCompacting        = "compacting"
	EventToolStalled       = "tool_stalled"
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
	case EventPlanProposal:
		target = &PlanProposalEvent{}
	case EventStreamReset:
		target = &StreamResetEvent{}
	case EventCompacting:
		target = &CompactingEvent{}
	case EventToolStalled:
		target = &ToolStalledEvent{}
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
	Enabled bool `json:"enabled"`
	// PlanFilePath is the absolute filesystem path of the plan markdown file
	// for this session. Empty when no plan file is associated with the run
	// (e.g. some early enter-emits that fire before allocation, or runs
	// restored without a path).
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanSlug is the human-readable identifier portion of the plan file
	// path — the basename minus the ".md" extension. Provided so clients
	// can display "Plan: happy-jumping-rabbit" without parsing the
	// filesystem path themselves. Legacy hex-hash plan files (from before
	// the word-slug generator shipped) round-trip through this field as
	// the raw hex string, so consumers should treat it as opaque.
	// Empty whenever PlanFilePath is empty.
	PlanSlug string `json:"planSlug,omitempty"`
}

func (PlanModeChangedEvent) eventType() string { return EventPlanModeChanged }

// PlanProposalEvent is a workflow-level signal emitted when the model proposes
// a plan-mode transition that requires user approval. It is distinct from
// PlanModeChangedEvent, which fires only on confirmed *state* transitions
// (SetPlanMode by the harness, run start with PlanMode=true, plan-mode abort,
// or the user-approval chokepoint).
//
// The Kind field discriminates the proposal:
//
//   - "exit" — emitted when the model calls the ExitPlanMode tool. The mode
//     itself does NOT change at this point; the engine merely surfaces the
//     proposal so consumers can present an approval UI. The PlanModeChangedEvent
//     with Enabled=false only fires later, after the consumer's user-approval
//     gate calls SetPlanMode(false).
//
// Future kinds ("enter", "amend", …) follow the same shape: a discriminator
// plus the proposal-specific fields. Consumers must switch on Kind and treat
// unknown kinds as forward-compatible no-ops.
//
// This event was introduced to un-conflate state-machine notifications from
// workflow signals — see docs/architecture/adr/003-state-events-vs-workflow-events.md
// for the full rationale. Carries PlanFilePath and PlanSlug directly so
// consumers don't have to scrape `permissionDenials.toolInput` to recover
// them.
type PlanProposalEvent struct {
	// Kind discriminates the proposal type. "exit" is the only kind emitted
	// today. Consumers must treat unknown kinds as forward-compatible.
	Kind string `json:"kind"`
	// PlanFilePath is the absolute filesystem path of the plan markdown file
	// associated with this proposal. Empty only in pathological cases where
	// the run somehow reached the proposal without a plan path allocated.
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanSlug is the human-readable identifier portion of the plan file
	// path — the basename minus the ".md" extension. See PlanModeChangedEvent
	// for the legacy-hex round-trip note.
	PlanSlug string `json:"planSlug,omitempty"`
}

func (PlanProposalEvent) eventType() string { return EventPlanProposal }

// PlanSlugFromPath extracts the human-readable slug portion of a plan
// file path: the basename minus the ".md" extension. Empty path → "".
//
// Examples:
//
//	"/home/u/.ion/plans/happy-jumping-rabbit.md" → "happy-jumping-rabbit"
//	"/repo/.ion/plans/ef072eb2660d099….md"      → "ef072eb2660d099…"  (legacy hex)
//	""                                          → ""
//
// Lives in the types package alongside PlanModeChangedEvent so that
// every emitter — and every consumer that wants to render the slug
// from a path it received via the wire — uses the same definition. The
// translation layer (session/event_translation.go) calls this as a
// fallback when an emitter forgot to populate PlanSlug, so populating
// it explicitly is good hygiene but not load-bearing.
func PlanSlugFromPath(path string) string {
	if path == "" {
		return ""
	}
	// Strip directory.
	base := path
	for i := len(base) - 1; i >= 0; i-- {
		if base[i] == '/' || base[i] == '\\' {
			base = base[i+1:]
			break
		}
	}
	// Defensive: a path consisting only of separators yields "" above
	// (we'd loop without ever finding a non-separator basename). The
	// loop above doesn't actually clear base in that case — it just
	// re-slices it to the same string when i==len-1 is a separator.
	// Handle the degenerate cases explicitly.
	if base == "." || base == "/" || base == "\\" || base == "" {
		return ""
	}
	// Strip a single trailing ".md" extension if present.
	const ext = ".md"
	if len(base) > len(ext) && base[len(base)-len(ext):] == ext {
		return base[:len(base)-len(ext)]
	}
	return base
}

// StreamResetEvent signals that a retry is about to occur and the client
// should discard any partial assistant text from the previous attempt.
type StreamResetEvent struct{}

func (StreamResetEvent) eventType() string { return EventStreamReset }

// CompactingEvent signals that context compaction is starting or finishing.
// Consumers can use this to surface activity state ("Compacting...").
// When Active is false the optional fields carry a summary of what was compacted
// so clients can render an inline compaction marker in the conversation.
type CompactingEvent struct {
	Active         bool   `json:"active"`
	Summary        string `json:"summary,omitempty"`
	MessagesBefore int    `json:"messagesBefore,omitempty"`
	MessagesAfter  int    `json:"messagesAfter,omitempty"`
	ClearedBlocks  int    `json:"clearedBlocks,omitempty"`
	Strategy       string `json:"strategy,omitempty"`
}

func (CompactingEvent) eventType() string { return EventCompacting }

// ToolStalledEvent is emitted when a tool call has been running longer
// than the stall threshold without returning. This is a heuristic signal
// that the tool may be blocked (e.g. by a macOS TCC permission dialog)
// or stuck on a slow operation. It is informational, not fatal.
type ToolStalledEvent struct {
	ToolID   string  `json:"toolId"`
	ToolName string  `json:"toolName"`
	Elapsed  float64 `json:"elapsed"`
}

func (ToolStalledEvent) eventType() string { return EventToolStalled }
