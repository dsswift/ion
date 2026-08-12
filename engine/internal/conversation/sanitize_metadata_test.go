package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestSanitizePreservesInternalMetadataWhenContentChanges(t *testing.T) {
	usage := &types.LlmUsage{InputTokens: 4321}
	messages := []types.LlmMessage{{
		Role: "assistant",
		Content: []types.LlmContentBlock{
			{Type: "text", Text: "keep"},
			{Type: "server_tool_use", ID: "orphan", Name: "web_search", Input: map[string]any{}},
		},
		EntryID: "assistant-entry",
		Usage:   usage,
	}}

	out := SanitizeMessages(messages)
	if len(out) != 1 {
		t.Fatalf("SanitizeMessages returned %d messages, want 1", len(out))
	}
	if out[0].EntryID != "assistant-entry" {
		t.Errorf("EntryID = %q, want assistant-entry", out[0].EntryID)
	}
	if out[0].Usage != usage {
		t.Errorf("Usage = %#v, want original pointer %#v", out[0].Usage, usage)
	}
	blocks := contentToBlockSlice(out[0].Content)
	if len(blocks) != 1 || blocks[0].Text != "keep" {
		t.Errorf("sanitized content = %#v, want surviving text block", blocks)
	}
}

func TestSanitizePreservesTransientMetadataWhenUserContentChanges(t *testing.T) {
	messages := []types.LlmMessage{{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "orphan", Content: "drop"},
			{Type: "text", Text: "transient reminder"},
		},
		Transient: true,
	}}

	out := SanitizeMessages(messages)
	if len(out) != 1 {
		t.Fatalf("SanitizeMessages returned %d messages, want 1", len(out))
	}
	if !out[0].Transient {
		t.Fatal("sanitization dropped transient provenance")
	}
	blocks := contentToBlockSlice(out[0].Content)
	if len(blocks) != 1 || blocks[0].Text != "transient reminder" {
		t.Errorf("sanitized content = %#v, want transient text", blocks)
	}
}
