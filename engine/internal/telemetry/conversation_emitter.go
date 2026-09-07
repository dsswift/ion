package telemetry

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Event name constants for the conversation.* family (issue #378 frozen
// contract C). Root and dispatched-child conversations both emit through
// ConversationEmitter below, so these four names are the family's complete
// vocabulary — no caller mints a fifth.
const (
	ConversationUserMessage      = "conversation.user_message"
	ConversationAssistantMessage = "conversation.assistant_message"
	ConversationToolCall         = "conversation.tool_call"
	ConversationLifecycle        = "conversation.lifecycle"
)

// Outcome vocabulary for ConversationEmitter.ToolCall. See ToolResultOutcome
// for how a *types.ToolResultEvent's existing IsError/Content fields resolve
// to one of these four values.
const (
	OutcomeSuccess = "success"
	OutcomeError   = "error"
	OutcomeDenied  = "denied"
	OutcomeBlocked = "blocked"
)

// LifecycleAction is the closed catalog of conversation.lifecycle actions
// (frozen contract G). Typed rather than a bare string so a caller that adds
// a seventh action fails to compile instead of silently emitting an unfrozen
// value — Lifecycle only accepts this type, never string.
type LifecycleAction string

const (
	ActionCreated   LifecycleAction = "created"
	ActionResumed   LifecycleAction = "resumed"
	ActionCompacted LifecycleAction = "compacted"
	ActionCleared   LifecycleAction = "cleared"
	ActionDetached  LifecycleAction = "detached"
	ActionDeleted   LifecycleAction = "deleted"
)

// CallCost carries one completed model call's own token buckets and USD
// cost (frozen contract E — cost reconciliation). AssistantMessage's cost
// parameter is a *CallCost specifically so "no cost available" (nil) and
// "cost is zero" (&CallCost{}) stay distinguishable: a nil pointer omits the
// payload's cost key entirely rather than emitting a zeroed object.
type CallCost struct {
	InputTokens              int
	OutputTokens             int
	CacheReadInputTokens     int
	CacheCreationInputTokens int
	CostUsd                  float64
}

// BeforeEventInfo is the correlation snapshot passed to a BeforeEventFunc —
// a package-local mirror of extension.BeforeConversationEventInfo. Kept
// separate rather than importing the extension package directly: telemetry
// is a low-level package with no business knowing about hook dispatch, so
// the session/dispatch layers that DO import extension are responsible for
// translating between the two shapes when they build the closure passed to
// SetBeforeEvent.
type BeforeEventInfo struct {
	EventName      string
	ConversationID string
	RunID          string
	DispatchID     string
	TraceID        string
}

// BeforeEventFunc is the extension-metadata seam a caller may attach to a
// ConversationEmitter. It is invoked immediately before each conversation.*
// event is handed to the Collector; a non-nil return value is merged into
// the emitted payload under "extension_metadata". Returning nil means no
// handler had an opinion — the payload gets no "extension_metadata" key.
type BeforeEventFunc func(info BeforeEventInfo) map[string]any

// ConversationEmitter builds and emits conversation.* telemetry through a
// dedicated Collector — the standalone conversation-events collector
// (NewConversationEventsCollector), never the general telemetry.* collector.
// The family carries full-fidelity content unconditionally: raw user
// message text, raw assistant response text, and raw tool input/output.
// There is no privacy-level gate — this is a security/audit stream by
// design, not a metrics stream, so it has no lower-fidelity tier to opt
// into. A nil *ConversationEmitter, or one constructed with a nil collector,
// is a valid no-op: every method below returns immediately without a nil
// check at the call site, so callers can hold "conversation events
// disabled" as an emitter that is simply inert.
type ConversationEmitter struct {
	collector   *Collector
	beforeEvent BeforeEventFunc
}

// NewConversationEmitter wraps the conversation-events Collector for
// conversation.* emission. Passing a nil collector produces a no-op emitter
// (see ConversationEmitter doc).
func NewConversationEmitter(collector *Collector) *ConversationEmitter {
	return &ConversationEmitter{collector: collector}
}

// SetBeforeEvent attaches the extension-metadata hook seam. Nil clears it
// (equivalent to never having called this). Returns the receiver so callers
// can chain it onto the constructor result at the call site.
func (e *ConversationEmitter) SetBeforeEvent(fn BeforeEventFunc) *ConversationEmitter {
	if e == nil {
		return e
	}
	e.beforeEvent = fn
	return e
}

// applyExtensionMetadata invokes the attached BeforeEventFunc (if any) and
// merges its result into payload["extension_metadata"]. traceID is read from
// ctx via the same key traceIDFromCorrelationContext already reads
// (telemetry.go), so this stays in sync with however TraceID is stamped on
// the emitted event.
func (e *ConversationEmitter) applyExtensionMetadata(payload, ctx map[string]any, eventName, conversationID, runID, dispatchID string) {
	if e.beforeEvent == nil {
		return
	}
	meta := e.beforeEvent(BeforeEventInfo{
		EventName:      eventName,
		ConversationID: conversationID,
		RunID:          runID,
		DispatchID:     dispatchID,
		TraceID:        traceIDFromCorrelationContext(ctx),
	})
	if meta != nil {
		payload["extension_metadata"] = meta
	}
}

// putID sets payload[key] only when value is non-empty, so a missing
// correlation ID (frozen contract F) omits the JSON key entirely rather than
// serializing an empty string. Every ConversationEmitter payload field is
// built through this helper for that reason.
func putID(payload map[string]any, key, value string) {
	if value == "" {
		return
	}
	payload[key] = value
}

// UserMessage emits conversation.user_message: one per accepted user turn,
// after the turn is durably persisted with a real entry ID. dispatchID is
// empty for root conversations (omitted from the payload); dispatched-child
// wiring supplies its dispatch ID. text is the raw user message content —
// this event is the audit trail's record of what the user actually sent.
func (e *ConversationEmitter) UserMessage(ctx map[string]any, conversationID, entryID, runID, dispatchID, text string) {
	if e == nil || e.collector == nil {
		return
	}
	payload := map[string]any{}
	putID(payload, "conversation_id", conversationID)
	putID(payload, "entry_id", entryID)
	putID(payload, "run_id", runID)
	putID(payload, "dispatch_id", dispatchID)
	putID(payload, "text", text)
	utils.LogWithFields(utils.LevelDebug, "telemetry", "conversation event emitted", map[string]any{
		"event": ConversationUserMessage, "conversation_id": conversationID, "entry_id": entryID,
		"run_id": runID, "dispatch_id": dispatchID,
	})
	e.applyExtensionMetadata(payload, ctx, ConversationUserMessage, conversationID, runID, dispatchID)
	e.collector.Event(ConversationUserMessage, payload, ctx)
}

// AssistantMessage emits conversation.assistant_message: one per completed
// assistant message, never for a partial/aborted stream with no completed
// message. cost is nil when the backend cannot supply call-level billing —
// the payload then has no "cost" key at all, never a zeroed object. text is
// the raw assistant response content — this event is the audit trail's
// record of what the model actually said.
func (e *ConversationEmitter) AssistantMessage(ctx map[string]any, conversationID, entryID, runID, dispatchID, model, text string, cost *CallCost) {
	if e == nil || e.collector == nil {
		return
	}
	payload := map[string]any{}
	putID(payload, "conversation_id", conversationID)
	putID(payload, "entry_id", entryID)
	putID(payload, "run_id", runID)
	putID(payload, "dispatch_id", dispatchID)
	putID(payload, "model", model)
	putID(payload, "text", text)
	if cost != nil {
		payload["cost"] = map[string]any{
			"input_tokens":                cost.InputTokens,
			"output_tokens":               cost.OutputTokens,
			"cache_read_input_tokens":     cost.CacheReadInputTokens,
			"cache_creation_input_tokens": cost.CacheCreationInputTokens,
			"cost_usd":                    cost.CostUsd,
		}
	}
	utils.LogWithFields(utils.LevelDebug, "telemetry", "conversation event emitted", map[string]any{
		"event": ConversationAssistantMessage, "conversation_id": conversationID, "entry_id": entryID,
		"run_id": runID, "dispatch_id": dispatchID, "model": model, "has_cost": cost != nil,
	})
	e.applyExtensionMetadata(payload, ctx, ConversationAssistantMessage, conversationID, runID, dispatchID)
	e.collector.Event(ConversationAssistantMessage, payload, ctx)
}

// ToolCall emits conversation.tool_call: one per terminal ToolResultEvent,
// including errors and policy denials. An invocation aborted before a
// terminal result emits nothing. There is deliberately no cost parameter —
// model cost stays on the assistant event even for tool-use turns, and
// omitting the parameter here enforces that structurally: a caller cannot
// attach cost to a tool event because the signature does not accept one.
// outcome is one of OutcomeSuccess/OutcomeError/OutcomeDenied/OutcomeBlocked
// — see ToolResultOutcome to derive it from a ToolResultEvent. input is the
// tool's decoded call arguments (nil when unavailable or unparseable —
// never fails the emission); output is the raw tool result content. Both
// are the audit trail's record of what the tool actually received and
// returned.
func (e *ConversationEmitter) ToolCall(ctx map[string]any, conversationID, entryID, toolUseID, toolName, runID, dispatchID, outcome string, input map[string]any, output string) {
	if e == nil || e.collector == nil {
		return
	}
	payload := map[string]any{}
	putID(payload, "conversation_id", conversationID)
	putID(payload, "entry_id", entryID)
	putID(payload, "tool_use_id", toolUseID)
	putID(payload, "tool_name", toolName)
	putID(payload, "run_id", runID)
	putID(payload, "dispatch_id", dispatchID)
	putID(payload, "outcome", outcome)
	if input != nil {
		payload["input"] = input
	}
	putID(payload, "output", output)
	utils.LogWithFields(utils.LevelDebug, "telemetry", "conversation event emitted", map[string]any{
		"event": ConversationToolCall, "conversation_id": conversationID, "tool_use_id": toolUseID,
		"tool_name": toolName, "run_id": runID, "dispatch_id": dispatchID, "outcome": outcome,
	})
	e.applyExtensionMetadata(payload, ctx, ConversationToolCall, conversationID, runID, dispatchID)
	e.collector.Event(ConversationToolCall, payload, ctx)
}

// Lifecycle emits conversation.lifecycle. Fired only after the successful
// durable mutation for actions where persistence is part of the action
// (created, resumed, compacted, cleared, deleted); detached fires on
// successful live-session removal (no persistence implied).
func (e *ConversationEmitter) Lifecycle(ctx map[string]any, conversationID string, action LifecycleAction, dispatchID string) {
	if e == nil || e.collector == nil {
		return
	}
	payload := map[string]any{}
	putID(payload, "conversation_id", conversationID)
	putID(payload, "action", string(action))
	putID(payload, "dispatch_id", dispatchID)
	utils.LogWithFields(utils.LevelDebug, "telemetry", "conversation event emitted", map[string]any{
		"event": ConversationLifecycle, "conversation_id": conversationID, "action": string(action),
		"dispatch_id": dispatchID,
	})
	e.applyExtensionMetadata(payload, ctx, ConversationLifecycle, conversationID, "", dispatchID)
	e.collector.Event(ConversationLifecycle, payload, ctx)
}

// ToolResultOutcome derives ToolCall's outcome argument from a
// *types.ToolResultEvent's existing IsError flag and Content text.
// ToolResultEvent (internal/types/normalized_event.go) carries no explicit
// denial/block discriminator field; internal/backend's runloop call sites
// already distinguish failure classes only through a Content string-prefix
// convention, so this reuses that convention rather than inventing a new
// classification scheme:
//
//   - "Permission denied: " — the permission engine denied the call
//     (internal/backend/runloop_tools.go) -> OutcomeDenied.
//   - "Blocked: " — a client tool gate or hook denied the call
//     (runloop_tool_gate.go, runloop_tools.go) -> OutcomeBlocked.
//   - "Sandbox blocked: " — the sandbox policy blocked the call
//     (runloop_workspaces.go, checkSandboxBlock path) -> OutcomeBlocked.
//
// Known gap: workspace-containment refusals (recordWorkspaceRefusal,
// runloop_workspaces.go) set Content to the bare workspaces.Refusal.Reason
// text with none of the above prefixes, so they fall through to
// OutcomeError rather than OutcomeBlocked. ToolResultEvent has no field that
// would let this function tell that case apart from a genuine execution
// error; per the program's Non-goals this child does not add one.
func ToolResultOutcome(isError bool, content string) string {
	if !isError {
		return OutcomeSuccess
	}
	switch {
	case strings.HasPrefix(content, "Permission denied: "):
		return OutcomeDenied
	case strings.HasPrefix(content, "Blocked: "), strings.HasPrefix(content, "Sandbox blocked: "):
		return OutcomeBlocked
	default:
		return OutcomeError
	}
}
