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
	EventPlanModeAutoExit  = "plan_mode_auto_exit"
	EventStreamReset       = "stream_reset"
	EventCompacting        = "compacting"
	EventToolStalled       = "tool_stalled"
	EventSteerInjected     = "steer_injected"
	EventModelFallback     = "model_fallback"
	EventRunStalled        = "run_stalled"
	// EventPlanContent is emitted in response to a get_plan_content command.
	// It carries a bounded byte-range window of a plan file so remote clients
	// can page through large plans without filesystem access to the engine host.
	EventPlanContent = "engine_plan_content"
	// Extended-thinking events surface the model's reasoning activity as a
	// first-class signal (issue #158). The engine receives Anthropic
	// thinking_delta stream events; these variants make them observable so
	// consumers can distinguish active reasoning from a genuine stall, and
	// render a "thinking" view. Emitted only when the provider supplies a
	// reasoning stream — thinking blocks are optional per turn.
	EventThinkingBlockStart = "thinking_block_start"
	EventThinkingDelta      = "thinking_delta"
	EventThinkingBlockEnd   = "thinking_block_end"
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
	case EventPlanModeAutoExit:
		target = &PlanModeAutoExitEvent{}
	case EventStreamReset:
		target = &StreamResetEvent{}
	case EventCompacting:
		target = &CompactingEvent{}
	case EventToolStalled:
		target = &ToolStalledEvent{}
	case EventSteerInjected:
		target = &SteerInjectedEvent{}
	case EventModelFallback:
		target = &ModelFallbackEvent{}
	case EventRunStalled:
		target = &RunStalledEvent{}
	case EventPlanContent:
		target = &PlanContentEvent{}
	case EventThinkingBlockStart:
		target = &ThinkingBlockStartEvent{}
	case EventThinkingDelta:
		target = &ThinkingDeltaEvent{}
	case EventThinkingBlockEnd:
		target = &ThinkingBlockEndEvent{}
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

// PlanModeAutoExitEvent signals that the engine synthesized an
// ExitPlanMode call at end-of-turn because the model failed to emit one
// on its own. Sibling to PlanProposalEvent (which fires when the model
// itself calls ExitPlanMode); both surface the plan-approval card to
// consumers, but PlanModeAutoExitEvent additionally tells consumers
// that this exit was engine-driven rather than model-driven.
//
// Consumers may use this to:
//   - distinguish "model exited cleanly" from "engine recovered the
//     stuck-in-plan-mode failure mode" for telemetry;
//   - render a subtle UI hint that the synthesis fired (e.g. "Plan
//     surfaced automatically — review carefully");
//   - feed back into prompt-quality dashboards that track how often
//     the model misroutes plan exit.
//
// Emission order during synthesis:
//  1. PlanModeAutoExitEvent (this event, identifies the synthesized
//     exit)
//  2. PlanProposalEvent{Kind:"exit"} (same first-class workflow signal
//     as model-driven exits)
//  3. TaskCompleteEvent with the synthesized PermissionDenial in
//     PermissionDenials so legacy consumers keying off the denial path
//     still see the approval card without changes.
//
// The event ships off by default in the sense that it cannot fire
// unless the engine is in plan mode AND the synthesis safety net is
// enabled (LimitsConfig.PlanModeAutoExitOnEndTurn /
// RunOptions.PlanModeAutoExit), so consumers that opt out of the
// synthesis never see this event.
type PlanModeAutoExitEvent struct {
	// SessionID is the engine session ID for this run. Empty only in
	// pathological cases where the run reaches synthesis without an
	// assigned session.
	SessionID string `json:"sessionId,omitempty"`
	// RunID is the engine-issued request ID for this run.
	RunID string `json:"runId,omitempty"`
	// StopReason is the provider stop reason ("end_turn" or "stop")
	// that triggered the synthesis. Other stop reasons never reach
	// this path.
	StopReason string `json:"stopReason"`
	// PlanFilePath is the resolved plan file path the synthesized
	// PermissionDenial references. Mirrors PlanProposalEvent.PlanFilePath.
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanSlug is the human-readable identifier portion of the plan
	// file path. See PlanSlugFromPath.
	PlanSlug string `json:"planSlug,omitempty"`
	// Reason is the human-readable reason recorded on the synthesized
	// PermissionDenial. Defaults to "engine-synthesized: run ended in
	// plan mode without ExitPlanMode call" but may be overridden by a
	// before_plan_mode_auto_exit hook handler.
	Reason string `json:"reason,omitempty"`
}

func (PlanModeAutoExitEvent) eventType() string { return EventPlanModeAutoExit }

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

// RunStalledEvent fires when the engine watchdog detects that an active
// run has made no progress (no provider stream events, no tool results,
// no turn boundaries) for longer than the configured run-stall threshold
// and cancels the run as a safety backstop. Emitted exactly once per
// stalled run, immediately before the engine cancels the run's context.
//
// This event is *advisory*: the authoritative completion signal is the
// follow-up TaskCompleteEvent (with a non-zero exit code) plus the
// emitExit call that fires after context cancellation propagates. A
// consumer that ignores RunStalledEvent entirely still sees the run
// reach a terminal state through the normal exit pipeline; the event
// exists so consumers that want to render "stalled" distinctly from
// "errored" (e.g. a watchdog icon vs. a generic error toast) can do so.
//
// The watchdog is the engine's last line of defense against subsystems
// that block indefinitely on a channel or syscall outside the reach of
// HTTP/2 pings or per-tool timeouts. See
// engine/internal/backend/runloop_watchdog.go for the implementation
// and the threshold default. Headless harnesses receive the event in
// the JSON stream and may abort, retry, notify, or ignore.
type RunStalledEvent struct {
	// StalledDuration is the elapsed time (seconds) since the last
	// recorded progress event on this run. Equal to or greater than
	// the configured run-stall threshold at emission time.
	StalledDuration float64 `json:"stalledDuration"`
	// LastActivity is a short human-readable description of the most
	// recent progress event observed (e.g. "provider stream chunk",
	// "tool result", "turn boundary"). Optional — included for
	// diagnostics so an operator reading the event stream can tell
	// where progress stopped without cross-referencing the engine
	// log. Empty string is permitted when no description is available.
	LastActivity string `json:"lastActivity,omitempty"`
}

func (RunStalledEvent) eventType() string { return EventRunStalled }

// SteerInjectedEvent is emitted when a mid-turn steer message is injected into
// the conversation before the next LLM call. Clients can use this to confirm
// that a steer message sent while the agent was running was successfully
// captured and will influence the model's next response.
type SteerInjectedEvent struct {
	// MessageLength is the character count of the injected steer message.
	// Provided so clients can display a non-empty confirmation without
	// echoing the full message back over the wire.
	MessageLength int `json:"messageLength"`
}

func (SteerInjectedEvent) eventType() string { return EventSteerInjected }

// ModelFallbackEvent is emitted once per run when the requested model
// could not be resolved to a provider and the engine fell back to the
// configured DefaultModel. Informational only — the run continues
// normally on the fallback model. Consumers (clients, parent extensions)
// may surface this however they wish; the engine never mutates stream
// content to communicate it.
//
// Workflow signal, not a state snapshot. It fires once at the swap site
// and is not replayed on reconnect; the engine does not retain it in any
// snapshot. Consumers that need sticky UI must project the fact into
// snapshot state at their own layer.
type ModelFallbackEvent struct {
	// RequestedModel is the model string the run was started with (e.g.
	// a tier alias like "standard" that didn't resolve to a configured tier).
	RequestedModel string `json:"requestedModel"`
	// FallbackModel is the engine's configured DefaultModel that the run
	// will actually use instead. Never empty when this event is emitted —
	// if there is no default to fall back to, the event is not emitted
	// and the engine returns the existing no_provider_found error.
	FallbackModel string `json:"fallbackModel"`
	// Reason is a short machine-readable code. Currently always
	// "no_provider_found"; reserved for future fallback triggers.
	Reason string `json:"reason"`
}

func (ModelFallbackEvent) eventType() string { return EventModelFallback }

// PlanContentEvent is emitted in response to a get_plan_content command.
// It delivers a bounded byte-range window of a plan file so remote clients
// (e.g. iOS) can page through large plans without needing filesystem access
// to the engine host.
//
// Paging semantics:
//   - Offset is the byte offset of the first byte in this window.
//   - Content is the UTF-8 window string for this page.
//   - TotalBytes is the file size at read time (may change between pages
//     if the model is still writing; treat as advisory).
//   - HasMore is true when offset+len(content) < TotalBytes, signaling
//     that the client should request the next page with offset+=len(content).
//
// Security: the engine validates that Path is inside the session's plan
// directory before reading. Requests with paths outside that directory are
// rejected with an error event, not a plan_content event.
//
// Incremental (not a snapshot). The engine does not replay on reconnect.
type PlanContentEvent struct {
	// PlanFilePath is the absolute path of the plan file that was read.
	// Clients can use it as a cache key when assembling multi-page fetches.
	PlanFilePath string `json:"planFilePath"`
	// Offset is the byte offset of the first byte of Content within the file.
	Offset int `json:"offset"`
	// Content is the UTF-8 string for this byte-range window.
	Content string `json:"content"`
	// TotalBytes is the file size in bytes at read time.
	TotalBytes int `json:"totalBytes"`
	// HasMore is true when more data follows (offset+len(content) < TotalBytes).
	HasMore bool `json:"hasMore"`
}

func (PlanContentEvent) eventType() string { return EventPlanContent }

// --- Extended-thinking events (issue #158) ---
//
// These three variants surface the model's reasoning activity as a first-class
// signal so consumers can (a) distinguish "actively reasoning" from "genuinely
// stalled" during long reasoning phases that produce no user-facing text, and
// (b) render a "thinking" view (collapsed-by-default reasoning panel) the way
// products like Claude and ChatGPT do.
//
// Emission contract:
//   - The engine emits these ONLY when the provider supplies a reasoning
//     stream (Anthropic extended thinking). Providers that don't stream
//     reasoning emit nothing — consumers must treat a thinking block as
//     OPTIONAL per turn and must not assume one exists.
//   - Boundaries (ThinkingBlockStartEvent / ThinkingBlockEndEvent) always emit
//     when a reasoning block is present; the per-token ThinkingDeltaEvent
//     stream is gated by ThinkingConfig.StreamDeltas (default on). A consumer
//     that disables delta streaming still receives the boundaries, so the
//     liveness signal and the block summary survive.
//   - signature_delta (Anthropic's opaque per-block signature) is NOT display
//     text and is never surfaced as a ThinkingDeltaEvent; it rides only in the
//     persisted assistant block.
//   - redacted_thinking blocks (encrypted, no readable text) emit
//     ThinkingBlockStartEvent and a ThinkingBlockEndEvent with Redacted=true
//     and produce no ThinkingDeltaEvent.

// ThinkingBlockStartEvent marks the start of a reasoning block. Empty payload;
// its arrival is the signal. Consumers create a "thinking" UI affordance and
// start a pulse/elapsed timer on receipt.
type ThinkingBlockStartEvent struct{}

func (ThinkingBlockStartEvent) eventType() string { return EventThinkingBlockStart }

// ThinkingDeltaEvent carries an incremental chunk of reasoning text — the peer
// of TextChunkEvent for the thinking channel. Gated by
// ThinkingConfig.StreamDeltas (default on).
type ThinkingDeltaEvent struct {
	Text string `json:"text"`
}

func (ThinkingDeltaEvent) eventType() string { return EventThinkingDelta }

// ThinkingBlockEndEvent marks the end of a reasoning block and carries a
// summary so consumers can render "💭 Thought for 14s" without having
// accumulated the deltas (and so consumers that disabled delta streaming, or
// that loaded the block from history without persisted text, still have a
// summary).
type ThinkingBlockEndEvent struct {
	// TotalTokens is an APPROXIMATE thinking-token count for this block.
	// Providers fold thinking into the final output-token usage (Anthropic
	// does not break out a per-block thinking-token count), so the engine
	// estimates this from accumulated reasoning text length (~chars/4) when
	// no authoritative count is available. Treat as advisory, not billing
	// ground truth.
	TotalTokens int `json:"totalTokens,omitempty"`
	// ElapsedSeconds is the wall-clock duration from block start to block end.
	ElapsedSeconds float64 `json:"elapsedSeconds,omitempty"`
	// Redacted is true for redacted_thinking blocks (encrypted reasoning with
	// no readable text). Consumers render a "redacted reasoning" affordance
	// rather than an empty block. When true, no ThinkingDeltaEvent was emitted
	// for this block.
	Redacted bool `json:"redacted,omitempty"`
}

func (ThinkingBlockEndEvent) eventType() string { return EventThinkingBlockEnd }
