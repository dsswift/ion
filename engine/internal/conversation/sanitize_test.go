package conversation

import (
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
