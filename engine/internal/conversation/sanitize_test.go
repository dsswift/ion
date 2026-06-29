package conversation

import (
	"fmt"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestSanitize_NilToolUseInputCoerced ensures sanitize coerces a nil
// tool_use.Input to an empty map. Without this, a poisoned conversation
// would replay forever — the API rejects messages whose tool_use.input
// is not a JSON object.
func TestSanitize_NilToolUseInputCoerced(t *testing.T) {
	msgs := []types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "hi"},
			},
		},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "tool_use", ID: "tool_1", Name: "ops", Input: nil},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "tool_1", Content: "ok"},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}

	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("assistant content not block slice: %T", out[1].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if blocks[0].Input == nil {
		t.Fatalf("expected Input to be coerced to empty map, got nil")
	}
	if len(blocks[0].Input) != 0 {
		t.Fatalf("expected Input to be empty map, got %v", blocks[0].Input)
	}
}

// TestSanitize_ContentToBlockSliceNilInput ensures that a tool_use block
// loaded from JSON with a non-object input value (e.g. string, null,
// missing) is still coerced to an empty map by Pass 1.
func TestSanitize_ContentToBlockSliceNilInput(t *testing.T) {
	// Simulate JSON that round-tripped via []interface{} where the input
	// field was a string (not a map) — contentToBlockSlice drops it,
	// leaving Input nil. Sanitize must repair this before serialization.
	rawContent := []interface{}{
		map[string]interface{}{
			"type":  "tool_use",
			"id":    "tool_2",
			"name":  "ops",
			"input": "not-a-dict",
		},
	}
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "go"}}},
		{Role: "assistant", Content: rawContent},
		{Role: "user", Content: []types.LlmContentBlock{{Type: "tool_result", ToolUseID: "tool_2", Content: "done"}}},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected normalized block slice, got %T", out[1].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if blocks[0].Input == nil {
		t.Fatalf("expected Input to be coerced to empty map, got nil")
	}
}

// TestSanitize_ServerToolUsePairingKept ensures properly paired server_tool_use
// and web_search_tool_result blocks within the same assistant message are preserved.
func TestSanitize_ServerToolUsePairingKept(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "search for Go testing"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Let me search for that."},
				{Type: "server_tool_use", ID: "srvtoolu_1", Name: "web_search", Input: map[string]any{"query": "Go testing"}},
				{Type: "web_search_tool_result", ToolUseID: "srvtoolu_1", Content: `[{"type":"web_search_result"}]`},
				{Type: "text", Text: "Here are the results."},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}
	if len(blocks) != 4 {
		t.Fatalf("expected all 4 blocks preserved, got %d", len(blocks))
	}
	if blocks[1].Type != "server_tool_use" {
		t.Fatalf("expected server_tool_use at index 1, got %s", blocks[1].Type)
	}
	if blocks[2].Type != "web_search_tool_result" {
		t.Fatalf("expected web_search_tool_result at index 2, got %s", blocks[2].Type)
	}
}

// TestSanitize_OrphanedServerToolUseRemoved ensures a server_tool_use block
// without a matching web_search_tool_result is stripped, while other blocks are kept.
func TestSanitize_OrphanedServerToolUseRemoved(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "search"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Searching..."},
				{Type: "server_tool_use", ID: "srvtoolu_orphan", Name: "web_search", Input: map[string]any{"query": "test"}},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (text only), got %d", len(blocks))
	}
	if blocks[0].Type != "text" {
		t.Fatalf("expected text block, got %s", blocks[0].Type)
	}
}

// TestSanitize_OrphanedWebSearchResultRemoved ensures a web_search_tool_result
// block without a matching server_tool_use is stripped.
func TestSanitize_OrphanedWebSearchResultRemoved(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Here you go."},
				{Type: "web_search_tool_result", ToolUseID: "srvtoolu_ghost", Content: `[{"type":"web_search_result"}]`},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (text only), got %d", len(blocks))
	}
	if blocks[0].Type != "text" {
		t.Fatalf("expected text block, got %s", blocks[0].Type)
	}
}

// TestSanitize_MixedClientAndServerTools reproduces the exact bug scenario:
// assistant message has tool_use (Agent) + server_tool_use (web_search, no result),
// followed by a user message with tool_result for the Agent call only.
// The orphaned server_tool_use must be stripped while the matched tool_use is kept.
func TestSanitize_MixedClientAndServerTools(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "analyze this"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "I'll search and run an agent."},
				{Type: "tool_use", ID: "toolu_agent1", Name: "Agent", Input: map[string]any{"prompt": "do stuff"}},
				{Type: "server_tool_use", ID: "srvtoolu_ws1", Name: "web_search", Input: map[string]any{"query": "test"}},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "toolu_agent1", Content: "agent done"},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}

	// Check assistant message: should have text + tool_use, NO server_tool_use
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}
	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks (text + tool_use), got %d", len(blocks))
	}
	if blocks[0].Type != "text" {
		t.Fatalf("expected text at index 0, got %s", blocks[0].Type)
	}
	if blocks[1].Type != "tool_use" {
		t.Fatalf("expected tool_use at index 1, got %s", blocks[1].Type)
	}

	// Check user message: tool_result should still be present
	userBlocks, ok := out[2].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[2].Content)
	}
	if len(userBlocks) != 1 || userBlocks[0].Type != "tool_result" {
		t.Fatalf("expected tool_result in user message, got %v", userBlocks)
	}
}

// TestSanitize_ServerToolUseNilInputCoerced ensures server_tool_use with nil
// Input is coerced to an empty map, matching the behavior for tool_use.
func TestSanitize_ServerToolUseNilInputCoerced(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "go"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Searching."},
				{Type: "server_tool_use", ID: "srvtoolu_nil", Name: "web_search", Input: nil},
				{Type: "web_search_tool_result", ToolUseID: "srvtoolu_nil", Content: `[]`},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}

	// Find the server_tool_use block
	var found bool
	for _, b := range blocks {
		if b.Type == "server_tool_use" {
			found = true
			if b.Input == nil {
				t.Fatalf("expected Input to be coerced to empty map, got nil")
			}
			if len(b.Input) != 0 {
				t.Fatalf("expected empty map, got %v", b.Input)
			}
		}
	}
	if !found {
		t.Fatalf("server_tool_use block not found in output")
	}
}

// TestSanitize_OnlyOrphanedServerToolUseDropsMessage ensures an assistant
// message containing ONLY an orphaned server_tool_use is dropped entirely.
func TestSanitize_OnlyOrphanedServerToolUseDropsMessage(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "search"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "server_tool_use", ID: "srvtoolu_only", Name: "web_search", Input: map[string]any{"query": "x"}},
			},
		},
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hello"}}},
	}

	out := SanitizeMessages(msgs)
	// The assistant message should be dropped entirely since it becomes empty
	if len(out) != 2 {
		t.Fatalf("expected 2 messages (assistant dropped), got %d", len(out))
	}
	if out[0].Role != "user" || out[1].Role != "user" {
		t.Fatalf("expected both remaining messages to be user, got %s and %s", out[0].Role, out[1].Role)
	}
}

// TestSanitize_EmptyTextBlockRemoved ensures a user message ending in an empty
// text block has that block stripped. This prevents Anthropic's
// "cache_control cannot be set for empty text blocks" rejection.
func TestSanitize_EmptyTextBlockRemoved(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "text", Text: "go"},
		}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "tool_use", ID: "t1", Name: "Read", Input: map[string]any{"file": "x"}},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "t1", Content: "ok"},
				{Type: "text", Text: ""},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	blocks, ok := out[2].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[2].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (tool_result only, empty text removed), got %d", len(blocks))
	}
	if blocks[0].Type != "tool_result" {
		t.Fatalf("expected tool_result, got %s", blocks[0].Type)
	}
}

// TestSanitize_OnlyEmptyTextBlockDropsMessage ensures a user message whose
// only block is an empty text block is dropped entirely.
func TestSanitize_OnlyEmptyTextBlockDropsMessage(t *testing.T) {
	msgs := []types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: ""},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 0 {
		t.Fatalf("expected 0 messages (empty text dropped), got %d", len(out))
	}
}

// TestSanitize_NonEmptyTextBlockPreserved ensures non-empty text blocks are
// NOT removed by the empty-text sanitization.
func TestSanitize_NonEmptyTextBlockPreserved(t *testing.T) {
	msgs := []types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "hello"},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 1 {
		t.Fatalf("expected 1 message, got %d", len(out))
	}
	blocks, ok := out[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[0].Content)
	}
	if len(blocks) != 1 || blocks[0].Text != "hello" {
		t.Fatalf("non-empty text block should be preserved, got %v", blocks)
	}
}

// TestSanitize_EmptyTextBlockInAssistantAlsoRemoved ensures empty text blocks
// are removed from assistant messages too, not just user messages.
func TestSanitize_EmptyTextBlockInAssistantAlsoRemoved(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: "hello"},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "response"},
				{Type: "text", Text: ""},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(out))
	}
	blocks, ok := out[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", out[1].Content)
	}
	if len(blocks) != 1 {
		t.Fatalf("expected 1 block (empty text removed), got %d", len(blocks))
	}
	if blocks[0].Text != "response" {
		t.Fatalf("expected 'response', got %q", blocks[0].Text)
	}
}

// ---------------------------------------------------------------------------
// ReplacePlanFilePlaceholder tests
// ---------------------------------------------------------------------------

// makeConvWithMessages is a test helper that builds a *Conversation with the
// given messages and corresponding EntryMessage entries so both code paths in
// ReplacePlanFilePlaceholder are exercised.
func makeConvWithMessages(msgs []types.LlmMessage) *Conversation {
	conv := &Conversation{
		ID:       "test",
		Messages: msgs,
	}
	for _, msg := range msgs {
		conv.Entries = append(conv.Entries, SessionEntry{
			ID:   fmt.Sprintf("e%d", len(conv.Entries)),
			Type: EntryMessage,
			Data: MessageData{Role: msg.Role, Content: msg.Content},
		})
	}
	return conv
}

// TestReplacePlanFile_StringContent ensures [plan-file] in plain string content
// is replaced in both Messages and Entries.
func TestReplacePlanFile_StringContent(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{Role: "user", Content: "Please read [plan-file] and summarize it."},
	})
	ReplacePlanFilePlaceholder(conv, "/tmp/plan.md")

	// Check message
	s, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatalf("expected string content, got %T", conv.Messages[0].Content)
	}
	if s != "Please read /tmp/plan.md and summarize it." {
		t.Fatalf("unexpected message content: %s", s)
	}

	// Check entry
	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatalf("entry data is not MessageData")
	}
	es, ok := md.Content.(string)
	if !ok {
		t.Fatalf("expected string entry content, got %T", md.Content)
	}
	if es != "Please read /tmp/plan.md and summarize it." {
		t.Fatalf("unexpected entry content: %s", es)
	}
}

// TestReplacePlanFile_TextBlock ensures [plan-file] in a text block's Text field
// is replaced in both Messages and Entries.
func TestReplacePlanFile_TextBlock(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "I'll write the plan to [plan-file] now."},
			},
		},
	})
	ReplacePlanFilePlaceholder(conv, "/home/user/plan.md")

	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[0].Content)
	}
	if blocks[0].Text != "I'll write the plan to /home/user/plan.md now." {
		t.Fatalf("unexpected text: %s", blocks[0].Text)
	}

	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatalf("entry data is not MessageData")
	}
	eBlocks, ok := md.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice in entry, got %T", md.Content)
	}
	if eBlocks[0].Text != "I'll write the plan to /home/user/plan.md now." {
		t.Fatalf("unexpected entry text: %s", eBlocks[0].Text)
	}
}

// TestReplacePlanFile_ToolResultContent ensures [plan-file] in a tool_result
// block's Content field is replaced.
func TestReplacePlanFile_ToolResultContent(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "t1", Content: "Wrote plan to [plan-file]"},
			},
		},
	})
	ReplacePlanFilePlaceholder(conv, "/plans/my-plan.md")

	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[0].Content)
	}
	if blocks[0].Content != "Wrote plan to /plans/my-plan.md" {
		t.Fatalf("unexpected content: %s", blocks[0].Content)
	}
}

// TestReplacePlanFile_ToolUseInputFilePath ensures [plan-file] in a tool_use
// block's Input["file_path"] is replaced.
func TestReplacePlanFile_ToolUseInputFilePath(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{
					Type: "tool_use",
					ID:   "t1",
					Name: "Write",
					Input: map[string]any{
						"file_path": "[plan-file]",
						"content":   "# Plan\n- step 1",
					},
				},
			},
		},
	})
	ReplacePlanFilePlaceholder(conv, "/tmp/plan.md")

	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[0].Content)
	}
	fp, ok := blocks[0].Input["file_path"].(string)
	if !ok {
		t.Fatalf("expected file_path to be string, got %T", blocks[0].Input["file_path"])
	}
	if fp != "/tmp/plan.md" {
		t.Fatalf("unexpected file_path: %s", fp)
	}
}

// TestReplacePlanFile_EmptyPath returns messages unchanged when planFilePath is empty.
func TestReplacePlanFile_EmptyPath(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{Role: "user", Content: "read [plan-file]"},
	})
	ReplacePlanFilePlaceholder(conv, "")

	s, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatalf("expected string content, got %T", conv.Messages[0].Content)
	}
	if s != "read [plan-file]" {
		t.Fatalf("placeholder should not be replaced when path is empty: %s", s)
	}
}

// TestReplacePlanFile_NilConversation does not panic on nil conversation.
func TestReplacePlanFile_NilConversation(t *testing.T) {
	ReplacePlanFilePlaceholder(nil, "/tmp/plan.md")
	// No panic = pass
}

// TestReplacePlanFile_NoPlaceholder leaves messages untouched when there is no
// placeholder to replace.
func TestReplacePlanFile_NoPlaceholder(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{Role: "user", Content: "No placeholder here."},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Nothing to replace."},
			},
		},
	})
	ReplacePlanFilePlaceholder(conv, "/tmp/plan.md")

	s, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatalf("expected string, got %T", conv.Messages[0].Content)
	}
	if s != "No placeholder here." {
		t.Fatalf("content should be unchanged: %s", s)
	}

	blocks, ok := conv.Messages[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[1].Content)
	}
	if blocks[0].Text != "Nothing to replace." {
		t.Fatalf("text should be unchanged: %s", blocks[0].Text)
	}
}

// TestReplacePlanFile_MultiplePlaceholdersInOneField ensures all occurrences
// within a single field are replaced.
func TestReplacePlanFile_MultiplePlaceholdersInOneField(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{Role: "user", Content: "Read [plan-file] then update [plan-file] please."},
	})
	ReplacePlanFilePlaceholder(conv, "/p.md")

	s, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatalf("expected string, got %T", conv.Messages[0].Content)
	}
	if s != "Read /p.md then update /p.md please." {
		t.Fatalf("both placeholders should be replaced: %s", s)
	}
}

// TestReplacePlanFile_Idempotent ensures calling the function twice with the
// same path produces the same result as calling it once.
func TestReplacePlanFile_Idempotent(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{Role: "user", Content: "see [plan-file]"},
	})
	ReplacePlanFilePlaceholder(conv, "/tmp/plan.md")
	ReplacePlanFilePlaceholder(conv, "/tmp/plan.md")

	s, ok := conv.Messages[0].Content.(string)
	if !ok {
		t.Fatalf("expected string, got %T", conv.Messages[0].Content)
	}
	if s != "see /tmp/plan.md" {
		t.Fatalf("unexpected content after double replace: %s", s)
	}
}

// TestReplacePlanFile_MixedBlockTypes ensures replacement works across multiple
// block types in a single message (text + tool_use + tool_result).
func TestReplacePlanFile_MixedBlockTypes(t *testing.T) {
	conv := makeConvWithMessages([]types.LlmMessage{
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "text", Text: "Writing to [plan-file]"},
				{Type: "tool_use", ID: "t1", Name: "Write", Input: map[string]any{
					"file_path": "[plan-file]",
					"content":   "plan body",
				}},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "t1", Content: "Wrote [plan-file] successfully"},
			},
		},
	})
	ReplacePlanFilePlaceholder(conv, "/x/plan.md")

	// Check assistant text block
	aBlocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[0].Content)
	}
	if aBlocks[0].Text != "Writing to /x/plan.md" {
		t.Fatalf("text not replaced: %s", aBlocks[0].Text)
	}
	fp, _ := aBlocks[1].Input["file_path"].(string)
	if fp != "/x/plan.md" {
		t.Fatalf("file_path not replaced: %s", fp)
	}

	// Check user tool_result content
	uBlocks, ok := conv.Messages[1].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice, got %T", conv.Messages[1].Content)
	}
	if uBlocks[0].Content != "Wrote /x/plan.md successfully" {
		t.Fatalf("tool_result content not replaced: %s", uBlocks[0].Content)
	}
}

// TestReplacePlanFile_EntriesFixed ensures entries with [plan-file] are fixed
// independently of messages, covering the persistence path where saveSplit
// rebuilds from entries via BuildContextPath and serializes to .tree.jsonl.
func TestReplacePlanFile_EntriesFixed(t *testing.T) {
	conv := &Conversation{
		ID: "test-entries",
		// Messages are empty — only entries matter for this test.
		Messages: nil,
		Entries: []SessionEntry{
			{
				ID:   "e0",
				Type: EntryMessage,
				Data: MessageData{
					Role:    "user",
					Content: "Read [plan-file] and continue.",
				},
			},
			{
				ID:   "e1",
				Type: EntryMessage,
				Data: MessageData{
					Role: "assistant",
					Content: []types.LlmContentBlock{
						{Type: "text", Text: "Writing to [plan-file]"},
						{Type: "tool_use", ID: "t1", Name: "Write", Input: map[string]any{
							"file_path": "[plan-file]",
							"content":   "# Plan",
						}},
					},
				},
			},
			{
				ID:   "e2",
				Type: EntryMessage,
				Data: MessageData{
					Role: "user",
					Content: []types.LlmContentBlock{
						{Type: "tool_result", ToolUseID: "t1", Content: "Wrote [plan-file] ok"},
					},
				},
			},
			{
				ID:   "e3",
				Type: EntryCompaction,
				Data: CompactionData{Summary: "should be ignored"},
			},
		},
	}

	ReplacePlanFilePlaceholder(conv, "/real/plan.md")

	// Entry 0: string content
	md0 := asMessageData(conv.Entries[0].Data)
	if md0 == nil {
		t.Fatalf("entry 0 data is not MessageData")
	}
	if s, ok := md0.Content.(string); !ok || s != "Read /real/plan.md and continue." {
		t.Fatalf("entry 0 content not replaced: %v", md0.Content)
	}

	// Entry 1: block content (text + tool_use)
	md1 := asMessageData(conv.Entries[1].Data)
	if md1 == nil {
		t.Fatalf("entry 1 data is not MessageData")
	}
	blocks1, ok := md1.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("entry 1 content not block slice: %T", md1.Content)
	}
	if blocks1[0].Text != "Writing to /real/plan.md" {
		t.Fatalf("entry 1 text not replaced: %s", blocks1[0].Text)
	}
	fp, _ := blocks1[1].Input["file_path"].(string)
	if fp != "/real/plan.md" {
		t.Fatalf("entry 1 file_path not replaced: %s", fp)
	}

	// Entry 2: tool_result content
	md2 := asMessageData(conv.Entries[2].Data)
	if md2 == nil {
		t.Fatalf("entry 2 data is not MessageData")
	}
	blocks2, ok := md2.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("entry 2 content not block slice: %T", md2.Content)
	}
	if blocks2[0].Content != "Wrote /real/plan.md ok" {
		t.Fatalf("entry 2 tool_result content not replaced: %s", blocks2[0].Content)
	}

	// Entry 3: compaction — should not be touched
	if _, ok := conv.Entries[3].Data.(CompactionData); !ok {
		t.Fatalf("entry 3 should still be CompactionData, got %T", conv.Entries[3].Data)
	}
}

// TestReplacePlanFile_EntriesFromMapAny exercises the code path where entry
// data has not been rehydrated (still a map[string]any from JSON) and contains
// [plan-file] markers. This happens when conversations are loaded from disk
// and round-tripped through JSON.
func TestReplacePlanFile_EntriesFromMapAny(t *testing.T) {
	conv := &Conversation{
		ID: "test-mapany",
		Entries: []SessionEntry{
			{
				ID:   "e0",
				Type: EntryMessage,
				Data: map[string]any{
					"role":    "user",
					"content": "Open [plan-file] please.",
				},
			},
		},
	}

	ReplacePlanFilePlaceholder(conv, "/fixed/plan.md")

	md := asMessageData(conv.Entries[0].Data)
	if md == nil {
		t.Fatalf("entry data not convertible to MessageData")
	}
	if s, ok := md.Content.(string); !ok || s != "Open /fixed/plan.md please." {
		t.Fatalf("entry content not replaced: %v", md.Content)
	}
}

// TestSanitizeStripsThinkingEvenWhenPersisted pins the never-resubmit
// invariant (issue #158): SanitizeMessages — the provider-submission
// sanitizer — must strip thinking blocks (readable AND redacted) even when
// the block carries persisted reasoning text. Persistence may retain the text
// for display, but it must never reach the model (Anthropic rejects
// re-submitted thinking). Reverting the "thinking || redacted_thinking" strip
// turns this test red.
func TestSanitizeStripsThinkingEvenWhenPersisted(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				// Persisted thinking block WITH reasoning text (the post-#158
				// persistThinking=on shape).
				{Type: "thinking", Thinking: "Let me reason about this carefully."},
				// Redacted thinking must also be stripped.
				{Type: "redacted_thinking", Thinking: ""},
				{Type: "text", Text: "Here is the answer."},
			},
		},
	}

	out := SanitizeMessages(msgs)

	for _, m := range out {
		blocks, ok := m.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, b := range blocks {
			if b.Type == "thinking" || b.Type == "redacted_thinking" {
				t.Fatalf("SanitizeMessages must strip thinking blocks before submission, found %q with text %q", b.Type, b.Thinking)
			}
		}
	}

	// The non-thinking text block must survive.
	last := out[len(out)-1]
	blocks, _ := last.Content.([]types.LlmContentBlock)
	foundText := false
	for _, b := range blocks {
		if b.Type == "text" && b.Text == "Here is the answer." {
			foundText = true
		}
	}
	if !foundText {
		t.Fatalf("non-thinking text block was incorrectly removed: %+v", out)
	}
}

// TestSanitizeStripsRedactedThinking isolates the redacted_thinking strip
// branch. The message carries a redacted_thinking block (encrypted reasoning,
// no readable text) as its ONLY reasoning-type block, plus a normal text
// block. SanitizeMessages must remove the redacted_thinking block (Anthropic
// rejects re-submitted reasoning; the engine never replays reasoning to the
// model) while preserving the text. Reverting the
// `|| b.Type == "redacted_thinking"` clause in sanitize.go turns this test
// red, pinning that branch explicitly rather than incidentally.
func TestSanitizeStripsRedactedThinking(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				// Redacted thinking: encrypted reasoning, no readable text.
				// This is the ONLY reasoning-type block in the message, so a
				// failure here unambiguously implicates the redacted branch.
				{Type: "redacted_thinking", Thinking: ""},
				{Type: "text", Text: "Final answer."},
			},
		},
	}

	out := SanitizeMessages(msgs)

	for _, m := range out {
		blocks, ok := m.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, b := range blocks {
			if b.Type == "redacted_thinking" {
				t.Fatalf("SanitizeMessages must strip redacted_thinking blocks before submission; found one with text %q", b.Thinking)
			}
		}
	}

	// The non-thinking text block must survive the strip.
	last := out[len(out)-1]
	blocks, _ := last.Content.([]types.LlmContentBlock)
	foundText := false
	for _, b := range blocks {
		if b.Type == "text" && b.Text == "Final answer." {
			foundText = true
		}
	}
	if !foundText {
		t.Fatalf("non-thinking text block was incorrectly removed alongside redacted_thinking: %+v", out)
	}
}

// TestSanitize_ToolResultImageReordered is the regression test for the
// Anthropic adjacency bug: a legacy conversation persisted a post-tool_use
// user message as [tool_result(A), image, tool_result(B)] (image interleaved
// between two parallel tool_results). Anthropic rejects this because the
// second tool_result is no longer immediately after the tool_use turn.
// SanitizeMessages must reorder it to [tool_result(A), tool_result(B), image]
// on the submission path. Reverting the partition step makes this test red.
func TestSanitize_ToolResultImageReordered(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "look at this"}}},
		{
			Role: "assistant",
			Content: []types.LlmContentBlock{
				{Type: "tool_use", ID: "tu_read", Name: "Read", Input: map[string]any{"file_path": "/shot.png"}},
				{Type: "tool_use", ID: "tu_glob", Name: "Glob", Input: map[string]any{"pattern": "*.ts"}},
			},
		},
		{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "tu_read", Content: "[Image: shot.png]"},
				{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: "iVBOR..."}},
				{Type: "tool_result", ToolUseID: "tu_glob", Content: "a.ts\nb.ts"},
			},
		},
	}

	out := SanitizeMessages(msgs)
	if len(out) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(out))
	}
	blocks, ok := out[2].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatalf("expected block slice for user tool-result message, got %T", out[2].Content)
	}
	if len(blocks) != 3 {
		t.Fatalf("expected 3 blocks, got %d: %+v", len(blocks), blocks)
	}
	// Both tool_results must lead the message, in their original relative order.
	if blocks[0].Type != "tool_result" || blocks[0].ToolUseID != "tu_read" {
		t.Errorf("block[0] = %q/%q, want tool_result/tu_read", blocks[0].Type, blocks[0].ToolUseID)
	}
	if blocks[1].Type != "tool_result" || blocks[1].ToolUseID != "tu_glob" {
		t.Errorf("block[1] = %q/%q, want tool_result/tu_glob", blocks[1].Type, blocks[1].ToolUseID)
	}
	// The image must follow all tool_results — never interleaved.
	if blocks[2].Type != "image" {
		t.Errorf("block[2] type = %q, want image (must follow all tool_results)", blocks[2].Type)
	}
}
