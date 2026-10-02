package ion

import "context"

// ConversationMessageAttachment is an image attached to a
// [ConversationMessage].
type ConversationMessageAttachment struct {
	ID string `json:"id"`
	// Type is the attachment kind, e.g. "image".
	Type string `json:"type"`
	Name string `json:"name"`
	// Path is the absolute path of the stored file.
	Path        string `json:"path"`
	MediaType   string `json:"mimeType,omitempty"`
	ContentHash string `json:"contentHash,omitempty"`
}

// ConversationBackgroundWorkItem is one background task named by a
// [ConversationBackgroundWork].
type ConversationBackgroundWorkItem struct {
	ID         string `json:"id"`
	Source     string `json:"source"`
	Label      string `json:"label,omitempty"`
	Status     string `json:"status"`
	ExitCode   int    `json:"exitCode"`
	ElapsedMs  int64  `json:"elapsedMs,omitempty"`
	OutputPath string `json:"outputPath,omitempty"`
}

// ConversationBackgroundWork marks a message as the delivery of a
// background-work result.
type ConversationBackgroundWork struct {
	Kind             string                           `json:"kind"`
	DeliveryMode     string                           `json:"deliveryMode"`
	Items            []ConversationBackgroundWorkItem `json:"items"`
	RemainingTaskIDs []string                         `json:"remainingTaskIds,omitempty"`
}

// ConversationMessage is one row of a conversation record: a user or
// assistant turn, a tool call, or a marker the engine recorded (compaction,
// plan, steer).
type ConversationMessage struct {
	// ID is the stable row id: the persisted entry id, or "<entryId>:<n>" for
	// later rows of one entry.
	ID string `json:"id,omitempty"`
	// Role is "user", "assistant", "tool", or "system".
	Role      string `json:"role"`
	Content   string `json:"content"`
	ToolName  string `json:"toolName,omitempty"`
	ToolID    string `json:"toolId,omitempty"`
	ToolInput string `json:"toolInput,omitempty"`
	// Timestamp is when the row was recorded, in Unix milliseconds.
	Timestamp int64 `json:"timestamp"`
	Internal  bool  `json:"internal,omitempty"`
	// IsError is set on a tool row whose result was an error.
	IsError bool `json:"isError,omitempty"`
	// BackgroundTaskID is the background task or dispatch that produced a
	// tool row.
	BackgroundTaskID string `json:"backgroundTaskId,omitempty"`

	// Slash-command invocation fields, set when a user turn came from one.
	SlashCommand        string         `json:"slashCommand,omitempty"`
	SlashArgs           string         `json:"slashArgs,omitempty"`
	SlashSource         string         `json:"slashSource,omitempty"`
	SlashModelAlias     string         `json:"slashModelAlias,omitempty"`
	SlashModelEffective string         `json:"slashModelEffective,omitempty"`
	SlashFrontmatter    map[string]any `json:"slashFrontmatter,omitempty"`

	// ImplementationPhase is set when the user turn began the implementation
	// half of a plan-then-implement flow.
	ImplementationPhase bool `json:"implementationPhase,omitempty"`

	// MarkerKind is the marker family for a "system" row: "compaction",
	// "plan", or "steer". The Marker* fields below carry that family's detail.
	MarkerKind            string `json:"markerKind,omitempty"`
	MarkerMessagesBefore  int    `json:"markerMessagesBefore,omitempty"`
	MarkerMessagesAfter   int    `json:"markerMessagesAfter,omitempty"`
	MarkerClearedBlocks   int    `json:"markerClearedBlocks,omitempty"`
	MarkerStrategy        string `json:"markerStrategy,omitempty"`
	MarkerMicroOnly       bool   `json:"markerMicroOnly,omitempty"`
	MarkerSummary         string `json:"markerSummary,omitempty"`
	MarkerTrigger         string `json:"markerTrigger,omitempty"`
	MarkerPreTokens       int    `json:"markerPreTokens,omitempty"`
	MarkerPlanOperation   string `json:"markerPlanOperation,omitempty"`
	MarkerPlanFilePath    string `json:"markerPlanFilePath,omitempty"`
	MarkerPlanSlug        string `json:"markerPlanSlug,omitempty"`
	MarkerMessageLength   int    `json:"markerMessageLength,omitempty"`
	MarkerMachineAuthored bool   `json:"markerMachineAuthored,omitempty"`

	BackgroundWork *ConversationBackgroundWork `json:"backgroundWork,omitempty"`
	// InjectionKind classifies an engine-injected user turn, e.g.
	// "agent_completion". Empty for an ordinary turn.
	InjectionKind string `json:"injectionKind,omitempty"`
	// MachineAuthored is set when the turn was written by a machine rather
	// than a person.
	MachineAuthored bool                            `json:"machineAuthored,omitempty"`
	Attachments     []ConversationMessageAttachment `json:"attachments,omitempty"`
}

// ReadConversationOpts pages [ConversationsAPI.Read].
type ReadConversationOpts struct {
	// Offset is the zero-based index of the first message to return.
	Offset int
	// Limit is the maximum number of messages to return. Zero returns every
	// message from Offset onward.
	Limit int
}

// ConversationRecord is one page of a conversation record.
type ConversationRecord struct {
	// Messages is the page, in record order. Never nil.
	Messages []ConversationMessage `json:"messages"`
	// Total is the record's full message count, independent of the page.
	Total int `json:"total"`
	// HasMore reports whether messages remain past this page.
	HasMore bool `json:"hasMore"`
}

// ConversationsAPI reads conversation records on the engine's host, reached
// via [Context.Conversations].
type ConversationsAPI struct{ ctx *Context }

// Conversations returns the conversation record surface.
func (c *Context) Conversations() *ConversationsAPI { return &ConversationsAPI{ctx: c} }

// Read returns one page of a conversation record by ID: its turns, each with
// a Timestamp. The engine reads the record from disk, so the conversation may
// be this one, another live one, or one that has already ended. Read-only.
//
// It fails when the conversation does not exist, when the engine's principal
// partitioning refuses this session access to it, or when the engine predates
// this call.
func (a *ConversationsAPI) Read(ctx context.Context, conversationID string, opts ReadConversationOpts) (*ConversationRecord, error) {
	var out ConversationRecord
	if err := a.ctx.sdk.call(ctx, "ext/read_conversation", map[string]any{
		"conversationId": conversationID,
		"offset":         opts.Offset,
		"limit":          opts.Limit,
	}, &out); err != nil {
		return nil, err
	}
	if out.Messages == nil {
		out.Messages = []ConversationMessage{}
	}
	return &out, nil
}
