package conversation

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Typed, cursor-paged transcript reads.
//
// LoadMessagesPaginated returns rows flattened for display and pages them by
// integer offset. A structured consumer needs the opposite on both counts: the
// tool calls and results as typed blocks in the order they were written, and a
// position that stays valid while the conversation keeps growing. A transcript
// page is the conversation's message entries in context-path order, each
// keeping its own blocks, addressed by a cursor that names the last entry
// returned rather than a count.

// ErrInvalidCursor is returned by ReadTranscriptPage when the cursor cannot be
// decoded, or names an entry the conversation no longer holds (a compaction
// dropped it). The caller restarts from the beginning.
var ErrInvalidCursor = errors.New("transcript cursor is not valid for this conversation")

// Transcript block types. Any other persisted block type passes through under
// its own name with its text, when it has any.
const (
	TranscriptBlockText       = "text"
	TranscriptBlockThinking   = "thinking"
	TranscriptBlockToolCall   = "tool_call"
	TranscriptBlockToolResult = "tool_result"
)

// TranscriptBlock is one content block of a transcript entry.
type TranscriptBlock struct {
	// Type is one of the TranscriptBlock* constants, or the persisted block
	// type for any other kind (for example "image").
	Type string `json:"type"`
	// Text is the body of a text or thinking block.
	Text string `json:"text,omitempty"`
	// ToolCallID joins a tool_call block to its tool_result block.
	ToolCallID string `json:"toolCallId,omitempty"`
	// ToolName is the tool a tool_call invokes. On a tool_result it is the
	// name of the call it answers, when that call is in the conversation.
	ToolName string `json:"toolName,omitempty"`
	// Input is a tool_call's arguments.
	Input map[string]any `json:"input,omitempty"`
	// Content is a tool_result's output.
	Content string `json:"content,omitempty"`
	// IsError marks a tool_result that reports a failure.
	IsError bool `json:"isError,omitempty"`
	// Truncated marks a block whose Text, Content, or Input was cut to fit
	// the page's byte budget. OriginalBytes is the size before the cut.
	Truncated     bool `json:"truncated,omitempty"`
	OriginalBytes int  `json:"originalBytes,omitempty"`
}

// TranscriptEntry is one persisted message of a conversation. ID is the
// conversation entry id: stable across reads, and unique in the conversation.
type TranscriptEntry struct {
	ID        string            `json:"id"`
	Role      string            `json:"role"`
	Timestamp int64             `json:"timestamp"`
	Blocks    []TranscriptBlock `json:"blocks"`
}

// TranscriptPageRequest selects one page. MaxEntries and MaxBytes must be
// positive; the caller owns the policy that picks them.
type TranscriptPageRequest struct {
	// Cursor is a NextCursor from an earlier page, or empty for the start.
	Cursor     string
	MaxEntries int
	MaxBytes   int
}

// TranscriptPage is one page of a conversation's transcript.
type TranscriptPage struct {
	Entries []TranscriptEntry
	// NextCursor resumes after the last entry of this page. When the page is
	// empty it repeats the request cursor, so a caller polling a growing
	// conversation always holds a usable position.
	NextCursor string
	// HasMore reports whether entries past this page exist right now.
	HasMore bool
	// TotalEntries counts every transcript entry the conversation holds.
	TotalEntries int
	// Bytes is the serialized size of Entries.
	Bytes int
}

// transcriptCursor is the decoded form of a page cursor. Index is a hint that
// skips the search when the entry has not moved; ID is the authority.
type transcriptCursor struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Index   int    `json:"i"`
}

const transcriptCursorVersion = 1

func encodeTranscriptCursor(id string, index int) string {
	raw, err := json.Marshal(transcriptCursor{Version: transcriptCursorVersion, ID: id, Index: index})
	if err != nil {
		// A struct of two scalars and a string always marshals.
		utils.LogWithFields(utils.LevelError, "conversation", "transcript cursor: encode failed", map[string]any{"error": err.Error()})
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func decodeTranscriptCursor(cursor string) (transcriptCursor, error) {
	raw, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return transcriptCursor{}, fmt.Errorf("%w: %v", ErrInvalidCursor, err)
	}
	var c transcriptCursor
	if err := json.Unmarshal(raw, &c); err != nil {
		return transcriptCursor{}, fmt.Errorf("%w: %v", ErrInvalidCursor, err)
	}
	if c.Version != transcriptCursorVersion || c.ID == "" {
		return transcriptCursor{}, fmt.Errorf("%w: version %d", ErrInvalidCursor, c.Version)
	}
	return c, nil
}

// ReadTranscriptPage loads the conversation id and returns the page req
// selects. It returns ErrNotFound when the conversation has no file and
// ErrInvalidCursor when the cursor does not name one of its entries.
//
// The page never exceeds req.MaxEntries entries. It never exceeds req.MaxBytes
// serialized bytes either, with one exception: an entry too large to fit a
// page on its own is returned alone with its blocks cut down, so a single
// oversized tool result can never stall a reader behind it.
func ReadTranscriptPage(id, dir string, req TranscriptPageRequest) (*TranscriptPage, error) {
	if req.MaxEntries <= 0 || req.MaxBytes <= 0 {
		return nil, fmt.Errorf("transcript page for %s: limits must be positive (entries=%d bytes=%d)", id, req.MaxEntries, req.MaxBytes)
	}
	conv, err := Load(id, dir)
	if err != nil {
		return nil, err
	}
	entries := transcriptEntries(conv)

	start := 0
	if req.Cursor != "" {
		cursor, err := decodeTranscriptCursor(req.Cursor)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "conversation", "transcript page: cursor rejected", map[string]any{"conversation_id": id, "error": err.Error()})
			return nil, err
		}
		at := transcriptIndexOf(entries, cursor)
		if at < 0 {
			utils.LogWithFields(utils.LevelWarn, "conversation", "transcript page: cursor entry not in conversation", map[string]any{"conversation_id": id, "entry_id": cursor.ID, "total_entries": len(entries)})
			return nil, fmt.Errorf("%w: entry %s", ErrInvalidCursor, cursor.ID)
		}
		start = at + 1
	}

	page := &TranscriptPage{Entries: []TranscriptEntry{}, NextCursor: req.Cursor, TotalEntries: len(entries)}
	truncated := false
	next := start
	for next < len(entries) && len(page.Entries) < req.MaxEntries {
		entry := entries[next]
		size := transcriptEntrySize(entry)
		if page.Bytes+size > req.MaxBytes {
			if len(page.Entries) > 0 {
				break
			}
			entry = truncateTranscriptEntry(entry, req.MaxBytes)
			size = transcriptEntrySize(entry)
			truncated = true
		}
		page.Entries = append(page.Entries, entry)
		page.Bytes += size
		page.NextCursor = encodeTranscriptCursor(entry.ID, next)
		next++
	}
	page.HasMore = next < len(entries)

	utils.LogWithFields(utils.LevelDebug, "conversation", "transcript page read", map[string]any{
		"conversation_id": id, "from": start, "count": len(page.Entries), "bytes": page.Bytes,
		"total_entries": len(entries), "has_more": page.HasMore, "truncated": truncated,
	})
	return page, nil
}

// transcriptIndexOf finds the cursor's entry, trying the hinted index first.
// Returns -1 when the entry is gone.
func transcriptIndexOf(entries []TranscriptEntry, cursor transcriptCursor) int {
	if cursor.Index >= 0 && cursor.Index < len(entries) && entries[cursor.Index].ID == cursor.ID {
		return cursor.Index
	}
	for i := range entries {
		if entries[i].ID == cursor.ID {
			return i
		}
	}
	return -1
}

// transcriptEntries converts the conversation's message entries, in
// context-path order, to transcript entries. Entries of other types carry no
// message and are left out.
func transcriptEntries(conv *Conversation) []TranscriptEntry {
	path := getContextPathEntries(conv)

	type message struct {
		entry  SessionEntry
		blocks []types.LlmContentBlock
		role   string
	}
	messages := make([]message, 0, len(path))
	toolNames := map[string]string{}
	for _, entry := range path {
		if entry.Type != EntryMessage {
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil {
			continue
		}
		blocks := contentToBlocks(md.Content)
		for _, b := range blocks {
			if b.Type == "tool_use" && b.ID != "" {
				toolNames[b.ID] = b.Name
			}
		}
		messages = append(messages, message{entry: entry, blocks: blocks, role: md.Role})
	}

	out := make([]TranscriptEntry, 0, len(messages))
	for _, m := range messages {
		blocks := make([]TranscriptBlock, 0, len(m.blocks))
		for _, b := range m.blocks {
			blocks = append(blocks, transcriptBlock(b, toolNames))
		}
		out = append(out, TranscriptEntry{ID: m.entry.ID, Role: m.role, Timestamp: m.entry.Timestamp, Blocks: blocks})
	}
	return out
}

func transcriptBlock(b types.LlmContentBlock, toolNames map[string]string) TranscriptBlock {
	switch b.Type {
	case "text":
		return TranscriptBlock{Type: TranscriptBlockText, Text: b.Text}
	case "thinking":
		return TranscriptBlock{Type: TranscriptBlockThinking, Text: b.Thinking}
	case "tool_use":
		return TranscriptBlock{Type: TranscriptBlockToolCall, ToolCallID: b.ID, ToolName: b.Name, Input: b.Input}
	case "tool_result":
		return TranscriptBlock{
			Type:       TranscriptBlockToolResult,
			ToolCallID: b.ToolUseID,
			ToolName:   toolNames[b.ToolUseID],
			Content:    b.Content,
			IsError:    b.IsError != nil && *b.IsError,
		}
	default:
		return TranscriptBlock{Type: b.Type, Text: b.Text, ToolCallID: b.ToolUseID}
	}
}

func transcriptEntrySize(entry TranscriptEntry) int {
	raw, err := json.Marshal(entry)
	if err != nil {
		// Input is a decoded JSON object, so this does not happen; an entry
		// that cannot be sized is treated as larger than any budget.
		utils.LogWithFields(utils.LevelError, "conversation", "transcript entry: marshal failed", map[string]any{"entry_id": entry.ID, "error": err.Error()})
		return int(^uint(0) >> 1)
	}
	return len(raw)
}

// truncateTranscriptEntry cuts an entry's block payloads until the entry fits
// budget. Every block keeps its type and identifiers; only Text, Content, and
// Input shrink. The per-block share starts at an even split of the budget and
// halves until the entry fits, so small blocks survive whole beside a large one.
func truncateTranscriptEntry(entry TranscriptEntry, budget int) TranscriptEntry {
	share := budget / max(len(entry.Blocks), 1)
	for {
		out := entry
		out.Blocks = make([]TranscriptBlock, len(entry.Blocks))
		for i, b := range entry.Blocks {
			out.Blocks[i] = truncateTranscriptBlock(b, share)
		}
		if share == 0 || transcriptEntrySize(out) <= budget {
			return out
		}
		share /= 2
	}
}

func truncateTranscriptBlock(b TranscriptBlock, share int) TranscriptBlock {
	original := 0
	cut := false
	if len(b.Text) > share {
		original += len(b.Text)
		b.Text = truncateUTF8(b.Text, share)
		cut = true
	}
	if len(b.Content) > share {
		original += len(b.Content)
		b.Content = truncateUTF8(b.Content, share)
		cut = true
	}
	if b.Input != nil {
		if raw, err := json.Marshal(b.Input); err != nil || len(raw) > share {
			original += len(raw)
			b.Input = nil
			cut = true
		}
	}
	if cut {
		b.Truncated = true
		b.OriginalBytes = original
	}
	return b
}

// truncateUTF8 returns the longest prefix of s that is at most limit bytes and
// does not split a rune.
func truncateUTF8(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	for limit > 0 && !utf8.RuneStart(s[limit]) {
		limit--
	}
	return s[:limit]
}
