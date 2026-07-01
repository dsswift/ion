package conversation

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// CurrentVersion is the schema version for new conversations.
const CurrentVersion = 2

// DefaultContext is the default context window size in tokens.
// Auto-compaction triggers below this — see AutoCompactTokenLimit, which
// reserves room for the next response and for the compaction summary itself.
const DefaultContext = 200000

// SessionEntryType identifies the kind of tree entry.
type SessionEntryType string

const (
	EntryMessage       SessionEntryType = "message"
	EntryCompaction    SessionEntryType = "compaction"
	EntryModelChange   SessionEntryType = "model_change"
	EntryLabel         SessionEntryType = "label"
	EntryCustom        SessionEntryType = "custom"
	EntryAgentDispatch SessionEntryType = "agent_dispatch"
	// EntryPlanMarker records a plan-file-written event so the "plan created /
	// updated" marker survives reload; it renders live via PlanFileWrittenEvent,
	// which is not persisted.
	EntryPlanMarker SessionEntryType = "plan_marker"
	// EntrySteerMarker records a steer-injection event so the steer marker
	// survives reload; it renders live via SteerInjectedEvent, which is not
	// persisted.
	EntrySteerMarker SessionEntryType = "steer_marker"
)

// MessageData holds a chat message entry.
type MessageData struct {
	Role       string          `json:"role"`
	Content    any             `json:"content"` // string or []types.LlmContentBlock
	Usage      *types.LlmUsage `json:"usage,omitempty"`
	Model      string          `json:"model,omitempty"`
	StopReason string          `json:"stopReason,omitempty"`

	// SlashCommand carries the raw slash-command invocation (including the
	// leading slash, e.g. "/diagram") when this user turn originated from a
	// slash command that the engine resolved and expanded. It is a display /
	// provenance field only: the engine attaches no behavior to it. When set,
	// the LLM-visible content (in conv.Messages) is the EXPANDED template body,
	// while this entry's Content holds the raw invocation the user typed, so
	// consumers render the command pill instead of the expanded text. Empty for
	// ordinary prompts.
	SlashCommand string `json:"slashCommand,omitempty"`
	// SlashArgs carries the raw argument string the user typed after the command
	// name (the text that was substituted into $ARGUMENTS / appended). Display
	// provenance only. Empty when the command was invoked with no args.
	SlashArgs string `json:"slashArgs,omitempty"`
	// SlashSource records where the command template was resolved from:
	// "extension" | "ion" | "claude" | "skill" | "project". Display provenance
	// only; lets a consumer label the pill by origin. Empty for ordinary prompts.
	SlashSource string `json:"slashSource,omitempty"`

	// DisplayOnly marks an entry that belongs in the tree/scrollback (so the
	// user sees it and it survives reload) but must NOT be reconstructed into
	// the LLM context by BuildContextPath. The canonical use is the `context:
	// fork` slash path: the parent conversation records the raw invocation as a
	// display turn so the user sees what they ran, but the parent's model never
	// consumed it (the expansion ran in a forked child). Without this flag,
	// saveSplit → BuildContextPath would resurrect the raw invocation as a user
	// message in the parent's .llm.jsonl on the next save, poisoning the parent's
	// context with a turn the model never saw. Default false: an ordinary entry
	// is part of the LLM context. Additive (omitempty) — absent on every legacy
	// entry, which correctly reconstructs as before.
	DisplayOnly bool `json:"displayOnly,omitempty"`
}

// CompactionData holds metadata about a compaction event. The enriched fields
// (MessagesBefore/After, ClearedBlocks, Strategy, MicroOnly) mirror the live
// CompactingEvent so the persisted compaction entry carries the same structured
// payload the live marker had. flattenEntries replays them as a system-role
// SessionMessage on historical reload. All enriched fields are additive
// (omitempty): legacy entries that lack them reload with zero values.
type CompactionData struct {
	Summary          string `json:"summary"`
	FirstKeptEntryID string `json:"firstKeptEntryId"`
	TokensBefore     int    `json:"tokensBefore"`
	MessagesBefore   int    `json:"messagesBefore,omitempty"`
	MessagesAfter    int    `json:"messagesAfter,omitempty"`
	ClearedBlocks    int    `json:"clearedBlocks,omitempty"`
	Strategy         string `json:"strategy,omitempty"`
	MicroOnly        bool   `json:"microOnly,omitempty"`
}

// LabelData holds a label annotation on an entry.
type LabelData struct {
	TargetID string  `json:"targetId"`
	Label    *string `json:"label"`
}

// PlanMarkerData records a plan file written event for persistence and replay.
// It mirrors the live PlanFileWrittenEvent so flattenEntries can replay a
// "plan created / updated" marker on historical reload.
type PlanMarkerData struct {
	Operation    string `json:"operation"` // "created" | "updated"
	PlanFilePath string `json:"planFilePath"`
	PlanSlug     string `json:"planSlug"`
}

// SteerMarkerData records a steer injection event for persistence and replay.
// It mirrors the live SteerInjectedEvent so flattenEntries can replay a steer
// marker on historical reload.
type SteerMarkerData struct {
	MessageLength int `json:"messageLength"`
}

// ModelChangeData records a model switch.
type ModelChangeData struct {
	Model         string `json:"model"`
	PreviousModel string `json:"previousModel,omitempty"`
}

// AgentDispatchData records a completed agent dispatch for persistence.
type AgentDispatchData struct {
	AgentName       string                   `json:"agentName"`
	AgentID         string                   `json:"agentId"`
	DisplayName     string                   `json:"displayName,omitempty"`
	Task            string                   `json:"task,omitempty"`
	Model           string                   `json:"model,omitempty"`
	Status          string                   `json:"status"`
	Elapsed         float64                  `json:"elapsed,omitempty"`
	ConversationID  string                   `json:"conversationId,omitempty"`
	ConversationIDs []string                 `json:"conversationIds,omitempty"`
	Dispatches      []map[string]interface{} `json:"dispatches,omitempty"`
	// DispatchDepth is the nesting depth of this dispatch from the root run
	// (0 for a top-level dispatch, 1 for its child, etc.). Persisted so the
	// depth attribution survives an engine restart and can be rehydrated onto
	// the agent-state row.
	DispatchDepth int `json:"dispatchDepth,omitempty"`
	// DispatchParentID is the dispatch id of the agent that spawned this one
	// (empty for a top-level dispatch). Persisted so the parent linkage
	// survives an engine restart and can be rehydrated onto the agent-state row.
	DispatchParentID string `json:"dispatchParentId,omitempty"`
}

// SessionEntry is a single node in the conversation tree.
type SessionEntry struct {
	ID        string           `json:"id"`
	ParentID  *string          `json:"parentId"`
	Type      SessionEntryType `json:"type"`
	Timestamp int64            `json:"timestamp"`
	Data      any              `json:"data"`
}

// TreeNode is a tree representation of entries for visualization.
type TreeNode struct {
	Entry    SessionEntry `json:"entry"`
	Children []TreeNode   `json:"children"`
}

// Conversation is the top-level session object.
type Conversation struct {
	ID                      string             `json:"id"`
	System                  string             `json:"system"`
	Model                   string             `json:"model"`
	Messages                []types.LlmMessage `json:"messages"`
	TotalInputTokens        int                `json:"totalInputTokens"`
	TotalOutputTokens       int                `json:"totalOutputTokens"`
	LastInputTokens         int                `json:"lastInputTokens"`
	LastInputTokensMsgCount int                `json:"lastInputTokensMsgCount,omitempty"`
	TotalCost               float64            `json:"totalCost"`
	CreatedAt               int64              `json:"createdAt"`
	Version                 int                `json:"version,omitempty"`
	ParentID                string             `json:"parentId,omitempty"`
	Entries                 []SessionEntry     `json:"entries,omitempty"`
	LeafID                  *string            `json:"leafId"`
	WorkingDirectory        string             `json:"workingDirectory,omitempty"`

	// _isLegacy is set by Load when reading a legacy .jsonl or .json file.
	// Save reads this flag to decide whether to unlink the legacy file after
	// writing the new split format. Not JSON-tagged — never persisted.
	_isLegacy bool
}

// ContextUsageInfo describes current context window consumption.
type ContextUsageInfo struct {
	Percent   int  `json:"percent"`
	Tokens    int  `json:"tokens"`
	Limit     int  `json:"limit"`
	Estimated bool `json:"estimated"`
}

// ToolResultEntry is a tool result to add as a user message.
type ToolResultEntry struct {
	ToolUseID string               `json:"tool_use_id"`
	Content   string               `json:"content"`
	IsError   bool                 `json:"is_error,omitempty"`
	Images    []*types.ImageSource `json:"images,omitempty"` // vision images to attach alongside text
}

// ContextFile is a discovered context file on disk.
type ContextFile struct {
	Path    string
	Content string
}

// GenEntryID generates an 8-character hex ID from crypto/rand.
func GenEntryID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// textBlock creates a text content block.
func textBlock(text string) types.LlmContentBlock {
	return types.LlmContentBlock{Type: "text", Text: text}
}

// CreateConversation initializes a new v2 conversation.
func CreateConversation(id, system, model string) *Conversation {
	return &Conversation{
		ID:        id,
		System:    system,
		Model:     model,
		Messages:  []types.LlmMessage{},
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		Entries:   []SessionEntry{},
		LeafID:    nil,
	}
}

// AddUserMessage appends a user message to the conversation. The same content
// becomes both the LLM-visible message (conv.Messages) and the persisted
// display entry (conv.Entries) — the right behavior for an ordinary prompt
// where what the user typed and what the model sees are identical.
//
// Returns the *SessionEntry that AppendEntry produced (the display/tree entry)
// so callers that need the entry id can thread it out. Returns nil when
// conv.Entries is nil (the LLM-only path that skips the tree write).
// Additive: existing callers that ignore the return value are unaffected.
func AddUserMessage(conv *Conversation, content any) *SessionEntry {
	blocks := toContentBlocks(content)

	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		return AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
	}
	return nil
}

// SlashInvocation captures the raw slash-command invocation that produced a
// user turn. The engine resolves and expands a slash command into the prompt
// the model sees, but the user must see the invocation they typed — so the
// LLM-visible content and the persisted/displayed content diverge. This struct
// is the display side of that split. All fields are provenance only; the engine
// attaches no behavior to them.
type SlashInvocation struct {
	// Command is the raw invocation including the leading slash, e.g. "/diagram".
	Command string
	// Args is the raw argument string the user typed after the command name.
	Args string
	// Source records where the template resolved from: "extension" | "ion" |
	// "claude" | "skill" | "project".
	Source string
}

// AddUserMessageWithInvocation appends a user turn whose LLM-visible content
// (expanded) differs from its persisted display content (the raw invocation).
//
// expandedContent is what the model consumes: the resolved template body with
// $ARGUMENTS substituted. It is written to conv.Messages so the provider request
// and token accounting see the full instructions. inv carries the raw
// invocation the user typed; it is written onto the display entry in
// conv.Entries (the .tree.jsonl) as the entry Content plus the SlashCommand /
// SlashArgs / SlashSource provenance fields, so consumers render the command
// pill — not the expanded body — and so the invocation survives a reload from
// disk (the entry tree is the source of truth for plain-conversation scrollback).
//
// This mirrors the Messages-vs-Entries divergence that AddTransientUserMessage
// and the SuppressSystemMessages path already rely on; the difference is that
// here BOTH stores receive an entry (the LLM gets the expansion, the tree gets
// the invocation), rather than one store being skipped.
//
// Returns the *SessionEntry that AppendEntry produced (the display/tree entry
// carrying the raw invocation) so callers that need the entry id can thread it
// out. Returns nil when conv.Entries is nil. Additive: existing callers that
// ignore the return value are unaffected.
func AddUserMessageWithInvocation(conv *Conversation, expandedContent any, inv SlashInvocation) *SessionEntry {
	expandedBlocks := toContentBlocks(expandedContent)

	// LLM sees the expanded template body.
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: expandedBlocks})

	// The display/tree entry shows the raw invocation, with provenance.
	if conv.Entries != nil {
		display := inv.Command
		if inv.Args != "" {
			display = inv.Command + " " + inv.Args
		}
		return AppendEntry(conv, EntryMessage, MessageData{
			Role:         "user",
			Content:      []types.LlmContentBlock{textBlock(display)},
			SlashCommand: inv.Command,
			SlashArgs:    inv.Args,
			SlashSource:  inv.Source,
		})
	}
	return nil
}

// toContentBlocks normalizes the loosely-typed content argument (string or
// []LlmContentBlock) into a content-block slice. Shared by AddUserMessage and
// AddUserMessageWithInvocation so the coercion rule stays in one place.
func toContentBlocks(content any) []types.LlmContentBlock {
	switch c := content.(type) {
	case string:
		return []types.LlmContentBlock{textBlock(c)}
	case []types.LlmContentBlock:
		return c
	default:
		return []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
	}
}

// AddTransientUserMessage appends a user message to the in-memory conversation
// for the current API call but does NOT persist it to the session entry list.
// Used when SuppressSystemMessages is enabled: the LLM sees the message, but
// it won't appear in session history on reload.
func AddTransientUserMessage(conv *Conversation, content string) {
	blocks := []types.LlmContentBlock{textBlock(content)}
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})
}

// AddContextInjectionMessage appends a read-triggered nested-context injection
// as a typed context_injection block (see BuildContextInjectionMessage). The
// block carries the rendered "# Context from <path>" body the model sees plus
// the structured ContextPaths the dedup seeder reads back.
//
// transient controls persistence, mirroring the AddUserMessage /
// AddTransientUserMessage split: when true (SuppressSystemMessages), the block
// is appended to conv.Messages only, so the model sees it this turn but it does
// not survive reload; when false, it is also written to the entry tree so the
// injection (and its ContextPaths) round-trips through persistence and the
// seeder recovers it on the next session.
func AddContextInjectionMessage(conv *Conversation, paths []string, renderedText string, transient bool) {
	msg := BuildContextInjectionMessage(paths, renderedText)
	conv.Messages = append(conv.Messages, msg)
	if transient {
		return
	}
	blocks, _ := msg.Content.([]types.LlmContentBlock)
	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
	}
}

// AddAssistantMessage appends an assistant message with usage tracking.
func AddAssistantMessage(conv *Conversation, blocks []types.LlmContentBlock, usage types.LlmUsage) {
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: blocks})
	// Track total context size including cached tokens. The API's input_tokens
	// field only counts non-cached tokens; cache_read and cache_creation must
	// be added to get the actual context window consumption.
	totalInput := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	conv.TotalInputTokens += totalInput
	conv.TotalOutputTokens += usage.OutputTokens
	conv.LastInputTokens = totalInput
	conv.LastInputTokensMsgCount = len(conv.Messages)

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "assistant", Content: blocks, Usage: &usage})
	}
}

// AddToolResults appends tool results as a user message with tool_result content blocks.
// All tool_result blocks are emitted first (in result order), then all image blocks
// (in result/image order). This ordering is load-bearing: the Anthropic API requires
// every tool_result in the post-tool_use user message to come immediately after the
// tool_use turn, so no image block may be interleaved between two tool_result blocks.
// With parallel tool calls where a non-final result carries an image, interleaving the
// image after its owning tool_result would separate a later tool_result from the
// tool_use turn and the API rejects the request ("tool_use ids were found without
// tool_result blocks immediately after"). Images still ride in the same user message,
// and each tool_result's text content (e.g. "[Image: foo.png]") keeps the image
// identifiable, so model comprehension is preserved.
func AddToolResults(conv *Conversation, results []ToolResultEntry) {
	var blocks []types.LlmContentBlock
	var imageBlocks []types.LlmContentBlock
	for _, r := range results {
		isErr := r.IsError
		blocks = append(blocks, types.LlmContentBlock{
			Type:      "tool_result",
			ToolUseID: r.ToolUseID,
			Content:   r.Content,
			IsError:   &isErr,
		})
		for _, img := range r.Images {
			imageBlocks = append(imageBlocks, types.LlmContentBlock{
				Type:   "image",
				Source: img,
			})
		}
	}
	blocks = append(blocks, imageBlocks...)
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		// Deep-copy blocks so MicroCompact mutations on conv.Messages
		// cannot corrupt the persisted entry history.
		entryCopy := make([]types.LlmContentBlock, len(blocks))
		copy(entryCopy, blocks)
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: entryCopy})
	}
}

// AddToolResultsWithSizeCheck appends tool results with an automatic size cap.
// Results exceeding maxChars are persisted to disk and replaced with a preview
// containing the first 2K characters plus a file path the model can Read.
// When maxChars <= 0, DefaultMaxToolResultChars is used.
func AddToolResultsWithSizeCheck(conv *Conversation, results []ToolResultEntry, convDir string, maxChars int) {
	for i := range results {
		replaced, persisted := PersistAndPreview(results[i].Content, results[i].ToolUseID, convDir, conv.ID, maxChars)
		if persisted {
			results[i].Content = replaced
		}
	}
	AddToolResults(conv, results)
}

// UpdateCost adds to the running cost total.
func UpdateCost(conv *Conversation, costUsd float64) {
	conv.TotalCost += costUsd
}

// SetAssistantMeta annotates the most recent assistant entry with model and
// stop reason metadata. This is called after AddAssistantMessage so callers
// that don't need metadata don't have to change.
func SetAssistantMeta(conv *Conversation, model, stopReason string) {
	if conv.Entries == nil {
		return
	}
	// Walk backwards to find the last assistant entry.
	for i := len(conv.Entries) - 1; i >= 0; i-- {
		if conv.Entries[i].Type != EntryMessage {
			continue
		}
		md := asMessageData(conv.Entries[i].Data)
		if md == nil || md.Role != "assistant" {
			continue
		}
		md.Model = model
		md.StopReason = stopReason
		conv.Entries[i].Data = *md
		return
	}
}
