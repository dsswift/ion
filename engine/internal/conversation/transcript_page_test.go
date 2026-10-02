package conversation

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
)

// saveTranscriptFixture writes a conversation with a user prompt, an
// assistant turn that speaks and calls a tool, and the tool's result.
func saveTranscriptFixture(t *testing.T, id string) *Conversation {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	conv := CreateConversation(id, "", "model-a")
	AddUserMessage(conv, "inspect the repo")
	AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "reading the file"},
		{Type: "tool_use", ID: "tool-1", Name: "Read", Input: map[string]any{"path": "/repo/a.go"}},
	}, types.LlmUsage{})
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "tool-1", Content: "package a", IsError: true}})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	return conv
}

func readPage(t *testing.T, id, cursor string, maxEntries, maxBytes int) *TranscriptPage {
	t.Helper()
	page, err := ReadTranscriptPage(id, "", TranscriptPageRequest{Cursor: cursor, MaxEntries: maxEntries, MaxBytes: maxBytes})
	if err != nil {
		t.Fatalf("ReadTranscriptPage: %v", err)
	}
	return page
}

// TestReadTranscriptPage_TypedBlocksInOrder pins the transcript shape: each
// message keeps its role, entry id, and blocks in written order, a tool call
// carries its name and input, and its result carries the same call id, the
// call's name, the output, and the error flag.
func TestReadTranscriptPage_TypedBlocksInOrder(t *testing.T) {
	conv := saveTranscriptFixture(t, "transcript-shape")
	page := readPage(t, conv.ID, "", 10, 1<<20)

	if len(page.Entries) != 3 || page.TotalEntries != 3 || page.HasMore {
		t.Fatalf("page = %d entries, total %d, hasMore %v; want 3, 3, false", len(page.Entries), page.TotalEntries, page.HasMore)
	}
	for i, e := range page.Entries {
		if e.ID == "" || e.ID != conv.Entries[i].ID || e.Timestamp == 0 {
			t.Errorf("entry %d identity = %+v, want persisted id %q", i, e, conv.Entries[i].ID)
		}
	}
	user, assistant, result := page.Entries[0], page.Entries[1], page.Entries[2]
	if user.Role != "user" || len(user.Blocks) != 1 || user.Blocks[0].Type != TranscriptBlockText || user.Blocks[0].Text != "inspect the repo" {
		t.Errorf("user entry = %+v", user)
	}
	if assistant.Role != "assistant" || len(assistant.Blocks) != 2 {
		t.Fatalf("assistant entry = %+v", assistant)
	}
	if b := assistant.Blocks[0]; b.Type != TranscriptBlockText || b.Text != "reading the file" {
		t.Errorf("assistant text block = %+v", b)
	}
	if b := assistant.Blocks[1]; b.Type != TranscriptBlockToolCall || b.ToolCallID != "tool-1" || b.ToolName != "Read" || b.Input["path"] != "/repo/a.go" {
		t.Errorf("tool call block = %+v", b)
	}
	if len(result.Blocks) != 1 {
		t.Fatalf("result entry = %+v", result)
	}
	if b := result.Blocks[0]; b.Type != TranscriptBlockToolResult || b.ToolCallID != "tool-1" || b.ToolName != "Read" || b.Content != "package a" || !b.IsError {
		t.Errorf("tool result block = %+v", b)
	}
}

// TestReadTranscriptPage_CursorPagesWithoutDuplicates pins cursor paging over
// a growing conversation: pages never repeat an entry, the last page still
// hands back a cursor, and a read with that cursor after an append returns
// only the appended entry.
func TestReadTranscriptPage_CursorPagesWithoutDuplicates(t *testing.T) {
	conv := saveTranscriptFixture(t, "transcript-cursor")

	first := readPage(t, conv.ID, "", 2, 1<<20)
	if len(first.Entries) != 2 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page = %d entries, hasMore %v, cursor %q", len(first.Entries), first.HasMore, first.NextCursor)
	}
	second := readPage(t, conv.ID, first.NextCursor, 2, 1<<20)
	if len(second.Entries) != 1 || second.HasMore || second.Entries[0].ID != conv.Entries[2].ID {
		t.Fatalf("second page = %+v, want only the third entry", second)
	}

	caughtUp := readPage(t, conv.ID, second.NextCursor, 2, 1<<20)
	if len(caughtUp.Entries) != 0 || caughtUp.HasMore || caughtUp.NextCursor != second.NextCursor {
		t.Fatalf("caught-up page = %+v, want empty with the same cursor", caughtUp)
	}

	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "done"}}, types.LlmUsage{})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	after := readPage(t, conv.ID, second.NextCursor, 10, 1<<20)
	if len(after.Entries) != 1 || after.Entries[0].Blocks[0].Text != "done" || after.TotalEntries != 4 {
		t.Fatalf("page after append = %+v, want only the new entry", after)
	}
}

// TestReadTranscriptPage_ByteBudgetBoundsPage pins the byte bound: a page
// stops before the entry that would exceed the budget, and that entry leads
// the next page.
func TestReadTranscriptPage_ByteBudgetBoundsPage(t *testing.T) {
	conv := saveTranscriptFixture(t, "transcript-bytes")
	all := readPage(t, conv.ID, "", 10, 1<<20)
	budget := transcriptEntrySize(all.Entries[0]) + transcriptEntrySize(all.Entries[1]) - 1

	page := readPage(t, conv.ID, "", 10, budget)
	if len(page.Entries) != 1 || !page.HasMore || page.Bytes > budget {
		t.Fatalf("page = %d entries, %d bytes (budget %d), hasMore %v; want 1 entry within budget", len(page.Entries), page.Bytes, budget, page.HasMore)
	}
	next := readPage(t, conv.ID, page.NextCursor, 10, 1<<20)
	if len(next.Entries) != 2 || next.Entries[0].ID != all.Entries[1].ID {
		t.Fatalf("next page = %+v, want it to start at the second entry", next)
	}
}

// TestReadTranscriptPage_OversizedEntryIsTruncated pins that an entry larger
// than the whole budget is returned alone, cut to fit, flagged, and still
// valid UTF-8, with its identifiers intact.
func TestReadTranscriptPage_OversizedEntryIsTruncated(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	conv := CreateConversation("transcript-oversized", "", "model-a")
	AddUserMessage(conv, "go")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "tool_use", ID: "tool-1", Name: "Bash", Input: map[string]any{"command": "cat big"}}}, types.LlmUsage{})
	big := strings.Repeat("é", 40_000)
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "tool-1", Content: big}})
	if err := Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	const budget = 2048
	head := readPage(t, conv.ID, "", 2, budget)
	page := readPage(t, conv.ID, head.NextCursor, 10, budget)
	if len(page.Entries) != 1 || page.HasMore {
		t.Fatalf("page = %d entries, hasMore %v; want the oversized entry alone", len(page.Entries), page.HasMore)
	}
	raw, err := json.Marshal(page.Entries)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(raw) > budget+2 {
		t.Errorf("serialized page is %d bytes, budget %d", len(raw), budget)
	}
	b := page.Entries[0].Blocks[0]
	if !b.Truncated || b.OriginalBytes != len(big) || b.Content == "" || !utf8.ValidString(b.Content) {
		t.Errorf("block truncated=%v originalBytes=%d contentLen=%d validUTF8=%v", b.Truncated, b.OriginalBytes, len(b.Content), utf8.ValidString(b.Content))
	}
	if b.ToolCallID != "tool-1" || b.ToolName != "Bash" || b.Type != TranscriptBlockToolResult {
		t.Errorf("truncated block lost its identity: %+v", b)
	}
}

// TestReadTranscriptPage_Errors pins the two distinct failures: a missing
// conversation, and a cursor that does not name an entry.
func TestReadTranscriptPage_Errors(t *testing.T) {
	conv := saveTranscriptFixture(t, "transcript-errors")
	req := TranscriptPageRequest{MaxEntries: 10, MaxBytes: 1 << 20}

	if _, err := ReadTranscriptPage("no-such-conversation", "", req); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing conversation error = %v, want ErrNotFound", err)
	}
	for name, cursor := range map[string]string{
		"garbage":       "not a cursor",
		"unknown entry": encodeTranscriptCursor("entry-that-is-not-there", 0),
	} {
		req.Cursor = cursor
		if _, err := ReadTranscriptPage(conv.ID, "", req); !errors.Is(err, ErrInvalidCursor) {
			t.Errorf("%s cursor error = %v, want ErrInvalidCursor", name, err)
		}
	}
	if _, err := ReadTranscriptPage(conv.ID, "", TranscriptPageRequest{}); err == nil {
		t.Error("a request with no limits was accepted, want an error")
	}
}
