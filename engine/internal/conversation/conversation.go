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
const DefaultContext = 200000

// SessionEntryType identifies the kind of tree entry.
type SessionEntryType string

const (
	EntryMessage     SessionEntryType = "message"
	EntryCompaction  SessionEntryType = "compaction"
	EntryModelChange SessionEntryType = "model_change"
	EntryLabel       SessionEntryType = "label"
	EntryCustom      SessionEntryType = "custom"
)

// MessageData holds a chat message entry.
type MessageData struct {
	Role    string          `json:"role"`
	Content any             `json:"content"` // string or []types.LlmContentBlock
	Usage   *types.LlmUsage `json:"usage,omitempty"`
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
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
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
func AddToolResults(conv *Conversation, results []ToolResultEntry) {
	blocks := make([]types.LlmContentBlock, len(results))
	for i, r := range results {
		isErr := r.IsError
		blocks[i] = types.LlmContentBlock{
			Type:      "tool_result",
			ToolUseID: r.ToolUseID,
			Content:   r.Content,
			IsError:   &isErr,
		}
	}
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
	}
}

// UpdateCost adds to the running cost total.
func UpdateCost(conv *Conversation, costUsd float64) {
	conv.TotalCost += costUsd
}
