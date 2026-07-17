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
	// EventPlanFileWritten is emitted the moment a Write/Edit successfully
	// lands on the canonical plan file during plan mode. It is distinct from
	// EventPlanModeChanged (which fires on plan-mode *entry*, before any file
	// exists): this event fires only after the plan file actually exists on
	// disk with content, so consumers can render a "plan created / updated"
	// marker at the true point in the conversation and a link that resolves.
	EventPlanFileWritten = "plan_file_written"
	EventStreamReset     = "stream_reset"
	EventCompacting      = "compacting"
	EventToolStalled     = "tool_stalled"
	EventSteerInjected   = "steer_injected"
	// EventPromptInjected is emitted when a prompt no client submitted is
	// injected into the session — an extension calling ctx.sendPrompt
	// (dispatch-completion delivery, check-ins, orchestrator revives). The
	// injected text persists as a genuine user turn in the conversation
	// file; this event is what lets LIVE clients render that turn without
	// reloading the file. Client-submitted prompts never emit it (each
	// client does its own optimistic transcript insert).
	EventPromptInjected = "prompt_injected"
	EventModelFallback  = "model_fallback"
	// EventCapabilityUnsupported signals that a requested feature (e.g. plan
	// mode) is not supported by the backend that would serve the run, and the
	// run was declined cleanly — no dispatch, no crash-shaped exit. See
	// CapabilityUnsupportedEvent in normalized_event_capability.go.
	EventCapabilityUnsupported = "capability_unsupported"
	EventRunStalled            = "run_stalled"
	// EventTaskSuspend is the engine-internal signal that ends an LLM run
	// without completing the dispatch. The agent's LLM run exits (saving
	// tokens, showing as idle in the UI) but its parent's OnComplete callback
	// does NOT fire. The dispatch remains alive in the registry; when a revive
	// message arrives via sendPrompt, runChild restarts the LLM run with the
	// new conversation context. This is the mechanism that lets a dispatched
	// lead agent go idle while waiting for its specialist children to complete,
	// without forcing a synchronous blocking dispatch on the orchestrator.
	// Consumers (desktop, iOS) may update the agent-state pill to show a
	// "suspended" or "idle" indicator while the dispatch is parked.
	EventTaskSuspend = "task_suspend"
	// EventPlanContent is emitted in response to a get_plan_content command.
	// It carries a bounded byte-range window of a plan file so remote clients
	// can page through large plans without filesystem access to the engine host.
	EventPlanContent = "engine_plan_content"
	// EventOidcLoginURL is delivered to the client that issued an
	// oidc_begin_login command. It carries what that consumer must surface
	// to the user: the authorization URL to open (interactive PKCE) or the
	// user code + verification URI to display (device-code flow). The
	// engine owns the rest of the flow — its loopback callback server (or
	// device-code polling) completes the exchange without further client
	// involvement.
	EventOidcLoginURL = "engine_oidc_login_url"
	// EventOidcIdentity is a complete snapshot of the operator's OIDC
	// identity state (signed in with claims, or signed out). Broadcast to
	// all clients on every state transition (login completion, logout) and
	// delivered to the requester of an oidc_identity command. Consumers
	// replace their local identity view with the payload.
	EventOidcIdentity = "engine_oidc_identity"
	// Extended-thinking events surface the model's reasoning activity as a
	// first-class signal (issue #158). The engine receives Anthropic
	// thinking_delta stream events; these variants make them observable so
	// consumers can distinguish active reasoning from a genuine stall, and
	// render a "thinking" view. Emitted only when the provider supplies a
	// reasoning stream — thinking blocks are optional per turn.
	EventThinkingBlockStart = "thinking_block_start"
	EventThinkingDelta      = "thinking_delta"
	EventThinkingBlockEnd   = "thinking_block_end"

	// Extension-surface events — decode targets that consumers map to from the
	// corresponding engine_* wire events, so every conversation (plain and
	// extension-hosted) can flow through a single normalized-event reducer
	// rather than a per-event-type switch. The engine emits the underlying
	// engine_* events; these bare-named variants are the normalized shapes a
	// consumer's normalize step produces. See
	// engine/internal/types/normalized_event_extensions.go for the structs.

	// EventMessageEnd reports the end of one LLM message within a run.
	// Carries that message's token usage and a seal flag marking it complete.
	EventMessageEnd = "message_end"

	// EventAgentState is a complete snapshot of every agent the engine
	// considers live at this moment. Consumers replace their local view —
	// do not merge incrementally.
	EventAgentState = "agent_state"

	// EventHarnessMessage is a display message injected by the extension
	// harness (e.g. a banner or inline status). Carries an optional dedupKey
	// so consumers can suppress repeated emissions within the same session.
	EventHarnessMessage = "harness_message"

	// EventWorkingMessage is a transient activity string produced by the
	// extension harness (e.g. "Compacting..."). It replaces the prior
	// working-message value; an empty string clears it.
	EventWorkingMessage = "working_message"

	// EventNotify is an ephemeral notification from the extension harness. It
	// is not part of the conversation history.
	EventNotify = "notify"

	// EventDialog is a request from the extension harness for a user response
	// (text input or option selection).
	EventDialog = "dialog"

	// EventExtensionDied signals that an extension subprocess exited
	// unexpectedly and the engine is attempting a respawn.
	EventExtensionDied = "extension_died"

	// EventExtensionRespawned signals that an extension subprocess was
	// successfully restarted after a previous crash.
	EventExtensionRespawned = "extension_respawned"

	// EventExtensionDeadPermanent signals that an extension subprocess has
	// exceeded the crash budget and will not be restarted automatically.
	EventExtensionDeadPermanent = "extension_dead_permanent"

	// EventEventsDropped signals that the event delivery buffer overflowed
	// and some events were discarded. State may be stale.
	EventEventsDropped = "events_dropped"

	// EventContextBreakdown carries a per-category token breakdown for the
	// active run. Emitted once after prompt assembly and again after the
	// first UsageEvent reconciliation (with APIReportedTotal and Unaccounted
	// populated). See ContextBreakdownEvent.
	EventContextBreakdown = "context_breakdown"

	// EventImageContent carries a single image produced during a run — either
	// returned by a tool (Source="tool", ToolID set) or generated by the
	// provider (Source="provider", ToolID empty). The engine is a pass-through
	// for images: it never generates them. The event carries a FILE PATH to the
	// saved image on disk (under the conversation's images/ directory), never
	// base64 bytes on the wire. See ImageContentEvent.
	EventImageContent = "image_content"
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
	case EventPlanFileWritten:
		target = &PlanFileWrittenEvent{}
	case EventStreamReset:
		target = &StreamResetEvent{}
	case EventCompacting:
		target = &CompactingEvent{}
	case EventToolStalled:
		target = &ToolStalledEvent{}
	case EventSteerInjected:
		target = &SteerInjectedEvent{}
	case EventPromptInjected:
		target = &PromptInjectedEvent{}
	case EventModelFallback:
		target = &ModelFallbackEvent{}
	case EventCapabilityUnsupported:
		target = &CapabilityUnsupportedEvent{}
	case EventRunStalled:
		target = &RunStalledEvent{}
	case EventTaskSuspend:
		target = &TaskSuspendEvent{}
	case EventPlanContent:
		target = &PlanContentEvent{}
	case EventThinkingBlockStart:
		target = &ThinkingBlockStartEvent{}
	case EventThinkingDelta:
		target = &ThinkingDeltaEvent{}
	case EventThinkingBlockEnd:
		target = &ThinkingBlockEndEvent{}
	// Extension-surface events (WI-001: single-path collapse)
	case EventMessageEnd:
		target = &MessageEndEvent{}
	case EventAgentState:
		target = &AgentStateEvent{}
	case EventHarnessMessage:
		target = &HarnessMessageEvent{}
	case EventWorkingMessage:
		target = &WorkingMessageEvent{}
	case EventNotify:
		target = &NotifyEvent{}
	case EventDialog:
		target = &DialogEvent{}
	case EventExtensionDied:
		target = &ExtensionDiedEvent{}
	case EventExtensionRespawned:
		target = &ExtensionRespawnedEvent{}
	case EventExtensionDeadPermanent:
		target = &ExtensionDeadPermanentEvent{}
	case EventEventsDropped:
		target = &EventsDroppedEvent{}
	case EventContextBreakdown:
		target = &ContextBreakdownEvent{}
	case EventImageContent:
		target = &ImageContentEvent{}
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
	// Images carries any vision images a tool returned alongside its text
	// output. Each entry references a FILE PATH on disk (under the
	// conversation's images/ directory), never base64 bytes — the engine saves
	// tool-returned image bytes to disk and puts the path here. Additive
	// (omitempty): absent for the overwhelming majority of tool results that
	// carry no images. Consumers that render tool output can display these
	// images inline; headless consumers may ignore them.
	Images []ToolResultImage `json:"images,omitempty"`
}

func (ToolResultEvent) eventType() string { return EventToolResult }

// ToolResultImage references a single image a tool produced. Path is the
// on-disk location of the saved image; MediaType is the MIME type (e.g.
// "image/png"); Source records provenance ("tool", "provider", or "user").
// The engine never puts base64 on the wire — Path is the durable reference.
type ToolResultImage struct {
	Path      string `json:"path"`
	MediaType string `json:"mediaType"`
	Source    string `json:"source,omitempty"`
}

// ImageContentEvent is emitted once per image produced during a run: a tool
// returned it (Source="tool", ToolID set to the producing tool call) or the
// provider generated it (Source="provider", ToolID empty). Path is the on-disk
// location of the saved image (under the conversation's images/ directory);
// the engine never puts base64 bytes on the wire. Sibling in spirit to the
// tool_result / text_chunk stream events — a typed data event the engine emits
// once and moves on; consumers render or ignore it as they choose.
type ImageContentEvent struct {
	Path      string `json:"path"`
	MediaType string `json:"mediaType"`
	Source    string `json:"source"`
	ToolID    string `json:"toolId,omitempty"`
}

func (ImageContentEvent) eventType() string { return EventImageContent }

// TaskUpdateEvent carries an updated assistant message mid-stream.
type TaskUpdateEvent struct {
	Message AssistantMessagePayload `json:"message"`
}

func (TaskUpdateEvent) eventType() string { return EventTaskUpdate }

// TaskCompleteEvent signals the end of an engine run.
type TaskCompleteEvent struct {
	Result string `json:"result"`
	// LastText is the last non-empty assistant text produced across all turns
	// of this run. When the final turn produces only thinking blocks (pure
	// reasoning), Result is empty but LastText carries the last substantive
	// text, letting consumers distinguish "silent final turn" from "silent run".
	// Empty when the run produced no text output at all.
	LastText   string  `json:"lastText,omitempty"`
	CostUsd    float64 `json:"costUsd"`
	DurationMs int64   `json:"durationMs"`
	NumTurns   int     `json:"numTurns"`
	// ConversationTurns is the conversation-lifetime prompt count: the number
	// of real user prompts across the whole conversation (see
	// conversation.CountUserPrompts), NOT the per-run round-trip count NumTurns
	// carries. The runloop computes it from the loaded conversation tree at
	// run-completion. Additive (omitempty): zero on backends/paths that do not
	// populate it, which serializes as absent.
	ConversationTurns int                `json:"conversationTurns,omitempty"`
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
	// EntryID is the canonical persisted entry id of the assistant message
	// this usage event closes. The runloop pre-mints it before emission and
	// persists the assistant entry under the same id, so consumers can re-key
	// their live-streamed assistant rows to the identity a later history load
	// returns (SessionMessage.ID). Empty on usage events that do not close an
	// assistant message (cache-token progress, compaction summaries).
	EntryID string `json:"entryId,omitempty"`
	// UserEntryID is the canonical persisted entry id of the user turn that
	// opened this run, letting consumers re-key their optimistic user row to
	// the same identity a history load returns. Empty when the run wrote no
	// user tree entry.
	UserEntryID string `json:"userEntryId,omitempty"`
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

// PlanFileWrittenEvent signals that a Write/Edit successfully landed on the
// canonical plan file during plan mode. Unlike PlanModeChangedEvent — which
// fires on plan-mode *entry*, before the model has written anything — this
// event fires only after the plan file actually exists on disk with content.
//
// Consumers use it to render the "plan created / plan updated" conversation
// marker at the accurate point in the transcript (right after the write that
// produced or changed the plan), with a link that resolves because the file
// now exists. Emitting the marker on plan-mode entry instead would place it
// before any narrative and link to a file that does not yet exist.
//
// Operation discriminates the write:
//   - "created" — the plan file did not exist (or was empty) before this
//     write. The first time content lands in a plan file for the session.
//   - "updated" — the plan file already had content before this write. A
//     subsequent revision of an existing plan.
//
// The engine is the only layer that can observe this distinction reliably (it
// stat's the file immediately before the write executes), so it carries the
// discriminator rather than forcing each consumer to reconstruct it.
type PlanFileWrittenEvent struct {
	// Operation is "created" or "updated". See the type doc.
	Operation string `json:"operation"`
	// PlanFilePath is the absolute filesystem path of the plan file that was
	// written. Always the canonical run plan file (stray plan-shaped targets
	// are redirected to it before the write executes).
	PlanFilePath string `json:"planFilePath,omitempty"`
	// PlanSlug is the human-readable identifier portion of the plan file path
	// (basename minus ".md"). See PlanModeChangedEvent for the legacy-hex note.
	PlanSlug string `json:"planSlug,omitempty"`
}

func (PlanFileWrittenEvent) eventType() string { return EventPlanFileWritten }

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
//
// MicroOnly is true when the completion represents a micro-compaction that
// cleared blocks (tool_result / long assistant text) without dropping any
// messages — i.e. MessagesBefore == MessagesAfter and the hard-truncate step
// was skipped. It is an explicit signal so consumers do not have to infer the
// micro-only case from MessagesBefore == MessagesAfter (a fragile heuristic).
// A client rendering a marker should not show an "N → N messages" figure when
// MicroOnly is true; nothing was dropped.
type CompactingEvent struct {
	Active         bool   `json:"active"`
	Summary        string `json:"summary,omitempty"`
	MessagesBefore int    `json:"messagesBefore,omitempty"`
	MessagesAfter  int    `json:"messagesAfter,omitempty"`
	ClearedBlocks  int    `json:"clearedBlocks,omitempty"`
	Strategy       string `json:"strategy,omitempty"`
	MicroOnly      bool   `json:"microOnly,omitempty"`
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

// Extended-thinking events (ThinkingBlockStartEvent / ThinkingDeltaEvent /
// ThinkingBlockEndEvent) are in normalized_event_thinking.go.
// Extension-surface NormalizedEvent types are in normalized_event_extensions.go.
// ContextBreakdownEvent and its row type are in context_breakdown_event.go.
