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
)

// MessageData holds a chat message entry.
type MessageData struct {
	Role       string          `json:"role"`
	Content    any             `json:"content"` // string or []types.LlmContentBlock
	Usage      *types.LlmUsage `json:"usage,omitempty"`
	Model      string          `json:"model,omitempty"`
	StopReason string          `json:"stopReason,omitempty"`
}

// CompactionData holds metadata about a compaction event.
type CompactionData struct {
	Summary          string `json:"summary"`
	FirstKeptEntryID string `json:"firstKeptEntryId"`
	TokensBefore     int    `json:"tokensBefore"`
}

// LabelData holds a label annotation on an entry.
type LabelData struct {
	TargetID string  `json:"targetId"`
	Label    *string `json:"label"`
}

// ModelChangeData records a model switch.
type ModelChangeData struct {
	Model         string `json:"model"`
	PreviousModel string `json:"previousModel,omitempty"`
}

// AgentDispatchData records a completed agent dispatch for persistence.
type AgentDispatchData struct {
	AgentName       string   `json:"agentName"`
	AgentID         string   `json:"agentId"`
	DisplayName     string   `json:"displayName,omitempty"`
	Task            string   `json:"task,omitempty"`
	Model           string   `json:"model,omitempty"`
	Status          string   `json:"status"`
	Elapsed         float64  `json:"elapsed,omitempty"`
	ConversationID  string   `json:"conversationId,omitempty"`
	ConversationIDs []string `json:"conversationIds,omitempty"`
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

// AddUserMessage appends a user message to the conversation.
func AddUserMessage(conv *Conversation, content any) {
	var blocks []types.LlmContentBlock
	switch c := content.(type) {
	case string:
		blocks = []types.LlmContentBlock{textBlock(c)}
	case []types.LlmContentBlock:
		blocks = c
	default:
		blocks = []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
	}

	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
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
// When a result includes images, each image is emitted as a separate image block
// immediately after the tool_result block so the LLM can see the visual content.
func AddToolResults(conv *Conversation, results []ToolResultEntry) {
	var blocks []types.LlmContentBlock
	for _, r := range results {
		isErr := r.IsError
		blocks = append(blocks, types.LlmContentBlock{
			Type:      "tool_result",
			ToolUseID: r.ToolUseID,
			Content:   r.Content,
			IsError:   &isErr,
		})
		for _, img := range r.Images {
			blocks = append(blocks, types.LlmContentBlock{
				Type:   "image",
				Source: img,
			})
		}
	}
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		// Deep-copy blocks so MicroCompact mutations on conv.Messages
		// cannot corrupt the persisted entry history.
		entryCopy := make([]types.LlmContentBlock, len(blocks))
		copy(entryCopy, blocks)
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: entryCopy})
	}
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
