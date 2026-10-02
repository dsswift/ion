package ion

import (
	"context"
	"errors"
	"fmt"
)

// Outcomes of [Context.ReadDispatchConversation]. Every outcome but
// [DispatchConversationOK] carries no entries.
const (
	// DispatchConversationOK: the page was read.
	DispatchConversationOK = "ok"
	// DispatchConversationUnauthorized: the target is not the conversation of
	// a dispatch this context created, directly or transitively, or its
	// lineage could not be established.
	DispatchConversationUnauthorized = "unauthorized"
	// DispatchConversationUnavailable: this context owns the dispatch, and
	// its conversation cannot be read. UnavailableReason says why.
	DispatchConversationUnavailable = "unavailable"
	// DispatchConversationInvalidCursor: the cursor does not name an entry of
	// the conversation. Read again without a cursor.
	DispatchConversationInvalidCursor = "invalid_cursor"
	// DispatchConversationUnsupported: the engine predates this method. Set
	// by the SDK, never by the engine.
	DispatchConversationUnsupported = "unsupported"
)

// Reasons a dispatch conversation is unavailable.
const (
	// DispatchConversationNotCreated: the child never started a conversation.
	DispatchConversationNotCreated = "not_created"
	// DispatchConversationNotFound: the conversation was started and its
	// record is no longer in the conversation store.
	DispatchConversationNotFound = "not_found"
)

// ReadDispatchConversationOpts selects one page of a dispatch's conversation.
// Name the target by ConversationID, by DispatchID, or by both, in which case
// both must name the same dispatch.
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

// DispatchConversationBlock is one content block of an entry.
type DispatchConversationBlock struct {
	// Type is "text", "thinking", "tool_call", or "tool_result". Any other
	// kind of block keeps its own type name (for example "image").
	Type string `json:"type"`
	// Text is the body of a text or thinking block.
	Text string `json:"text,omitempty"`
	// ToolCallID joins a tool_call block to its tool_result block.
	ToolCallID string `json:"toolCallId,omitempty"`
	// ToolName is the tool a tool_call invokes, and on a tool_result the name
	// of the call it answers.
	ToolName string `json:"toolName,omitempty"`
	// Input is a tool_call's arguments.
	Input map[string]any `json:"input,omitempty"`
	// Content is a tool_result's output.
	Content string `json:"content,omitempty"`
	// IsError marks a tool_result that reports a failure.
	IsError bool `json:"isError,omitempty"`
	// Truncated marks a block whose Text, Content, or Input was cut to fit
	// the page's byte budget. OriginalBytes is its size before the cut.
	Truncated     bool `json:"truncated,omitempty"`
	OriginalBytes int  `json:"originalBytes,omitempty"`
}

// DispatchConversationEntry is one message of a dispatch's conversation. ID
// is stable across reads and unique in the conversation. Blocks are in the
// order they were written.
type DispatchConversationEntry struct {
	ID        string                      `json:"id"`
	Role      string                      `json:"role"`
	Timestamp int64                       `json:"timestamp"`
	Blocks    []DispatchConversationBlock `json:"blocks"`
}

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
// reason there is none. Branch on Outcome.
type DispatchConversationResult struct {
	Outcome string `json:"outcome"`
	// UnavailableReason is set only when Outcome is "unavailable".
	UnavailableReason string `json:"unavailableReason,omitempty"`

	// The dispatch fields are set whenever this context owns the dispatch:
	// on "ok", "unavailable", and "invalid_cursor".
	ConversationID string `json:"conversationId,omitempty"`
	DispatchID     string `json:"dispatchId,omitempty"`
	AgentName      string `json:"agentName,omitempty"`
	// Status is "running" or "suspended" while the dispatch is live, and its
	// final status ("done", "error", "cancelled", "lost") once it has ended.
	Status string `json:"status,omitempty"`
	// Terminal is true once the dispatch has ended.
	Terminal bool `json:"terminal"`
	// Reason is the terminal reason: the error text for "error", the recall
	// reason for "cancelled". It is never part of the transcript.
	Reason string `json:"reason,omitempty"`
	// ExitCode is nil when unknown.
	ExitCode *int `json:"exitCode,omitempty"`

	// Entries is the page, oldest first. Never nil.
	Entries []DispatchConversationEntry `json:"entries"`
	// NextCursor resumes after the last entry returned so far. Pass it back
	// to read only what was written since, including on a live conversation
	// whose current page reports HasMore false.
	NextCursor string `json:"nextCursor,omitempty"`
	// HasMore reports whether entries past this page exist right now.
	HasMore bool `json:"hasMore"`
	// TotalEntries counts every entry the conversation holds right now.
	TotalEntries int `json:"totalEntries"`
	// Limits reports the bounds this read ran under. Set on "ok".
	Limits *DispatchConversationLimits `json:"limits,omitempty"`
}

// ReadDispatchConversation returns one bounded page of the conversation of a
// dispatch this context owns, while it runs or after it ends: the root
// context owns every dispatch, a dispatched agent only its strict
// descendants. The engine decides ownership from its own dispatch lineage.
//
// A refusal is a result, not an error: check Outcome. Against an engine that
// predates the method the result is [DispatchConversationUnsupported].
func (c *Context) ReadDispatchConversation(ctx context.Context, opts ReadDispatchConversationOpts) (*DispatchConversationResult, error) {
	if opts.ConversationID == "" && opts.DispatchID == "" {
		return nil, fmt.Errorf("ion: ReadDispatchConversation requires a ConversationID or a DispatchID")
	}
	var out DispatchConversationResult
	if err := c.sdk.call(ctx, "ext/read_dispatch_conversation", opts, &out); err != nil {
		if errors.Is(err, ErrMethodNotFound) {
			return &DispatchConversationResult{Outcome: DispatchConversationUnsupported, Entries: []DispatchConversationEntry{}}, nil
		}
		return nil, err
	}
	if out.Entries == nil {
		out.Entries = []DispatchConversationEntry{}
	}
	return &out, nil
}
