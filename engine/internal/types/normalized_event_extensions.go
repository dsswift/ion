// Package types — extension-surface NormalizedEvent types (WI-001).
//
// These variants are decode targets: consumers parse them from the
// corresponding engine_* wire events so that every conversation — plain and
// extension-hosted — can flow through a single normalized-event reducer rather
// than a per-event-type switch. They carry no engine emission site; the engine
// emits the underlying engine_* events, and a consumer's normalize step maps
// each to one of these variants.
//
// Split from normalized_event.go to stay under the 800-line cap.
package types

// MessageEndEvent reports the end of one LLM message within a multi-turn run.
// Carries that message's token usage and a seal flag marking the message
// complete (so a consumer does not append the next text_chunk to a message
// that has already ended).
type MessageEndEvent struct {
	// InputTokens is the number of input tokens consumed by this LLM message.
	InputTokens int `json:"inputTokens,omitempty"`
	// OutputTokens is the number of output tokens produced by this LLM message.
	OutputTokens int `json:"outputTokens,omitempty"`
	// ContextPercent is the fraction of the model's context window that has
	// been consumed (0.0–100.0).
	ContextPercent float64 `json:"contextPercent,omitempty"`
	// Cost is the estimated USD cost of this LLM message.
	Cost float64 `json:"cost,omitempty"`
	// EntryID is the canonical persisted entry id of the assistant message
	// this end closes (mirrors MessageEndUsage.EntryID). Consumers re-key the
	// just-sealed assistant row to it so a later history load
	// (SessionMessage.ID) dedups against the live row.
	EntryID string `json:"entryId,omitempty"`
	// UserEntryID is the canonical persisted entry id of the run-opening user
	// turn (mirrors MessageEndUsage.UserEntryID).
	UserEntryID string `json:"userEntryId,omitempty"`
}

func (MessageEndEvent) eventType() string { return EventMessageEnd }

// UserTurnPersistedEvent reports that the run-opening user turn has been
// appended to the conversation and persisted, carrying its canonical
// tree-entry id. Emitted once per run by the API backend, immediately after
// the inbound user message is persisted and before streaming begins.
//
// This is a RE-KEY signal, not a user-turn echo: it carries only the id,
// never the content (the engine does not echo user turns — see the
// appendInboundUserMessage comment in runloop.go). Consumers that inserted
// an optimistic user row re-key it to EntryID so later history loads
// (SessionMessage.ID) dedup against it. message_end carries the same id as
// UserEntryID, but only fires on runs that reach a message end — a run
// cancelled or failed mid-stream never re-keys via that path, which is
// exactly the gap this event closes.
type UserTurnPersistedEvent struct {
	// EntryID is the canonical persisted tree-entry id of the user turn.
	EntryID string `json:"entryId"`
}

func (UserTurnPersistedEvent) eventType() string { return EventUserTurnPersisted }

// AgentStateEvent is a complete snapshot of every dispatch agent the engine
// considers live at this moment. Consumers replace their local view with the
// payload — do not merge incrementally, do not invent retention rules. Every
// code path that ends an agent's run must transition it to a terminal status
// (done/error/cancelled) before the next snapshot. See agent-state.md.
type AgentStateEvent struct {
	// Agents is the complete current agent list. An empty slice means no agents
	// are live; consumers must clear their local state.
	Agents []AgentStateUpdate `json:"agents"`
}

func (AgentStateEvent) eventType() string { return EventAgentState }

// HarnessMessageEvent is a display message injected by the extension harness
// (e.g. a banner or inline status, or a "/clear" divider). Carries an optional
// dedupKey so consumers can suppress repeated emissions within a session.
type HarnessMessageEvent struct {
	// Message is the display text.
	Message string `json:"message"`
	// DedupKey is an optional client-honored idempotency token. When present,
	// consumers suppress the message if a prior harness message with the same
	// key was already seen. Empty string means no dedup.
	DedupKey string `json:"dedupKey,omitempty"`
	// Source is an optional string identifying the origin of the message
	// (e.g. "clear" for /clear dividers). Informational only.
	Source string `json:"source,omitempty"`
	// DedupMode is a client-honored retention hint. Absent/"" = suppress-later
	// (default: ignore a later message with the same DedupKey). "relocate" =
	// move-forward (remove any existing message with this DedupKey, append the
	// new one at the end).
	DedupMode string `json:"dedupMode,omitempty"`
}

func (HarnessMessageEvent) eventType() string { return EventHarnessMessage }

// WorkingMessageEvent is a transient activity string from the extension
// harness (e.g. "Compacting…"). It replaces the prior working-message value;
// an empty string clears it.
type WorkingMessageEvent struct {
	// Message is the new working-message text. Empty string clears it.
	Message string `json:"message"`
}

func (WorkingMessageEvent) eventType() string { return EventWorkingMessage }

// NotifyEvent is an ephemeral notification from the extension harness. It is
// not part of the conversation history; a consumer decides whether and how to
// surface it.
type NotifyEvent struct {
	// Message is the notification body text.
	Message string `json:"message"`
	// Level is the severity indicator: "info", "warning", or "error".
	Level string `json:"level"`
}

func (NotifyEvent) eventType() string { return EventNotify }

// DialogEvent is a request from the extension harness for a user response
// (text input or option selection). The consumer sends the answer back via
// the engine's dialog_response command, echoing DialogID.
type DialogEvent struct {
	// DialogID is the correlation identifier the consumer echoes back in the
	// dialog_response command.
	DialogID string `json:"dialogId"`
	// Method describes the input type: "prompt" (free text) or "select"
	// (option list).
	Method string `json:"method"`
	// Title is the dialog heading.
	Title string `json:"title"`
	// Options is the list of selectable values (only meaningful for
	// method="select").
	Options []string `json:"options,omitempty"`
	// DefaultValue is the pre-filled initial value for text inputs.
	DefaultValue string `json:"defaultValue,omitempty"`
}

func (DialogEvent) eventType() string { return EventDialog }

// ExtensionDiedEvent reports that an extension subprocess exited unexpectedly
// and the engine is attempting a respawn. The conversation continues after the
// extension restarts.
type ExtensionDiedEvent struct {
	// ExtensionName identifies which extension crashed.
	ExtensionName string `json:"extensionName"`
}

func (ExtensionDiedEvent) eventType() string { return EventExtensionDied }

// ExtensionRespawnedEvent reports that an extension subprocess was
// successfully restarted after a previous crash.
type ExtensionRespawnedEvent struct {
	// ExtensionName identifies which extension was restarted.
	ExtensionName string `json:"extensionName"`
	// AttemptNumber is the 1-based restart attempt count within the
	// current crash window.
	AttemptNumber int `json:"attemptNumber"`
}

func (ExtensionRespawnedEvent) eventType() string { return EventExtensionRespawned }

// ExtensionDeadPermanentEvent reports that an extension subprocess exceeded
// the crash budget and will not be restarted automatically. Recovery requires
// the conversation to be reopened.
type ExtensionDeadPermanentEvent struct {
	// ExtensionName identifies the permanently dead extension.
	ExtensionName string `json:"extensionName"`
	// AttemptNumber is the total number of restart attempts that were made
	// before the extension was declared permanently dead.
	AttemptNumber int `json:"attemptNumber"`
}

func (ExtensionDeadPermanentEvent) eventType() string { return EventExtensionDeadPermanent }

// EventsDroppedEvent reports that the event delivery buffer overflowed and
// some events were discarded, so consumer state may be stale. A consumer may
// trigger a reconcile request in response.
type EventsDroppedEvent struct {
	// Count is the number of events that were dropped.
	Count int `json:"count"`
}

func (EventsDroppedEvent) eventType() string { return EventEventsDropped }
