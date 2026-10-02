package extension

import "github.com/dsswift/ion/engine/internal/conversation"

// Outcomes of Context.ReadDispatchConversation. Every outcome but "ok" returns
// no entries.
const (
	// DispatchConversationOK: the page was read.
	DispatchConversationOK = "ok"
	// DispatchConversationUnauthorized: the target is not the conversation of
	// a dispatch the caller created, directly or transitively, or its lineage
	// could not be established.
	DispatchConversationUnauthorized = "unauthorized"
	// DispatchConversationUnavailable: the caller owns the dispatch, and its
	// conversation cannot be read. UnavailableReason says why.
	DispatchConversationUnavailable = "unavailable"
	// DispatchConversationInvalidCursor: the cursor does not name an entry of
	// the conversation. Read again without a cursor.
	DispatchConversationInvalidCursor = "invalid_cursor"
)

// Reasons a dispatch conversation is unavailable.
const (
	// DispatchConversationNotCreated: the dispatch ended, or has not yet
	// reached the point, without its child starting a conversation.
	DispatchConversationNotCreated = "not_created"
	// DispatchConversationNotFound: the conversation was started and its
	// record is no longer in the conversation store.
	DispatchConversationNotFound = "not_found"
)

// ReadDispatchConversationOpts selects one page of a dispatch's conversation.
// The target is named by ConversationID, by DispatchID, or by both, in which
// case both must name the same dispatch.
type ReadDispatchConversationOpts struct {
	ConversationID string `json:"conversationId,omitempty"`
	DispatchID     string `json:"dispatchId,omitempty"`
	// Cursor is the NextCursor of an earlier page. Empty reads from the start.
	Cursor string `json:"cursor,omitempty"`
	// Limit is the most entries wanted. Zero means the engine default; a value
	// above the engine maximum is lowered to it.
	Limit int `json:"limit,omitempty"`
	// MaxBytes is the serialized-byte budget wanted for the page's entries.
	// Zero means the engine default; a value above the engine maximum is
	// lowered to it.
	MaxBytes int `json:"maxBytes,omitempty"`
}

// DispatchConversationEntry is one message of a dispatch's conversation, with
// its content blocks in the order they were written.
type DispatchConversationEntry = conversation.TranscriptEntry

// DispatchConversationBlock is one content block of an entry: text, thinking,
// a tool call with its input, or a tool result.
type DispatchConversationBlock = conversation.TranscriptBlock

// DispatchConversationLimits reports the bounds a read ran under.
type DispatchConversationLimits struct {
	// Entries and Bytes are the bounds applied to this page.
	Entries int `json:"entries"`
	Bytes   int `json:"bytes"`
	// MaxEntries and MaxBytes are the most a caller may ask for.
	MaxEntries int `json:"maxEntries"`
	MaxBytes   int `json:"maxBytes"`
}

// DispatchConversationResult is one page of a dispatch's conversation, or the
// reason there is none.
type DispatchConversationResult struct {
	// Outcome is one of the DispatchConversation* outcome constants.
	Outcome string `json:"outcome"`
	// UnavailableReason is set only when Outcome is "unavailable".
	UnavailableReason string `json:"unavailableReason,omitempty"`

	// The fields below are set when the caller owns the dispatch: on "ok",
	// "unavailable", and "invalid_cursor". They are absent on "unauthorized".

	ConversationID string `json:"conversationId,omitempty"`
	DispatchID     string `json:"dispatchId,omitempty"`
	AgentName      string `json:"agentName,omitempty"`
	// Status is "running" or "suspended" while the dispatch is live, and its
	// final status ("done", "error", "cancelled", "lost") once it has ended.
	Status string `json:"status,omitempty"`
	// Terminal is true once the dispatch has ended. A page with HasMore false
	// on a non-terminal dispatch is the current end, not the final one.
	Terminal bool `json:"terminal"`
	// Reason is the terminal reason: the error text for "error", the recall
	// reason for "cancelled". It is never part of the transcript.
	Reason string `json:"reason,omitempty"`
	// ExitCode is the dispatch result's exit code, absent when unknown.
	ExitCode *int `json:"exitCode,omitempty"`

	// Entries is the page, oldest first. Always an array, never null.
	Entries []DispatchConversationEntry `json:"entries"`
	// NextCursor resumes after the last entry returned. It is set on every
	// "ok" page that has returned at least one entry so far, including the
	// last page of a live conversation, so the next read returns only what
	// was written since.
	NextCursor string `json:"nextCursor,omitempty"`
	// HasMore reports whether entries past this page exist right now.
	HasMore bool `json:"hasMore"`
	// TotalEntries counts every entry the conversation holds right now.
	TotalEntries int `json:"totalEntries"`
	// Limits reports the bounds this read ran under. Set on "ok".
	Limits *DispatchConversationLimits `json:"limits,omitempty"`
}
