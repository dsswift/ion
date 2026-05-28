package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestMessagesAfterLastCompactBoundary_NoBoundary returns the whole
// slice when no boundary exists. This is the no-op happy path: the very
// first compaction of a fresh conversation scans every message.
func TestMessagesAfterLastCompactBoundary_NoBoundary(t *testing.T) {
	conv := CreateConversation("no-boundary", "", "test")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}}, types.LlmUsage{})

	slice := MessagesAfterLastCompactBoundary(conv)
	if len(slice) != 2 {
		t.Errorf("expected whole slice (2 msgs), got %d", len(slice))
	}
}

// TestMessagesAfterLastCompactBoundary_StartsAtMostRecent verifies that
// when multiple boundaries exist (a multi-round-compacted session), the
// slice starts at the most recent boundary — not the first. This is the
// duplication firewall the gentle-knitting-cup plan calls for: prior
// summaries stay in-context for the model but are out-of-scope for fact
// extraction on the next pass.
func TestMessagesAfterLastCompactBoundary_StartsAtMostRecent(t *testing.T) {
	conv := CreateConversation("multi-boundary", "", "test")
	AddUserMessage(conv, "pre-1")
	conv.Messages = append(conv.Messages, BuildCompactBoundaryMessage(CompactMeta{
		Trigger: "auto", Summary: "first boundary",
	}))
	AddUserMessage(conv, "between")
	conv.Messages = append(conv.Messages, BuildCompactBoundaryMessage(CompactMeta{
		Trigger: "auto", Summary: "second boundary",
	}))
	AddUserMessage(conv, "after")

	slice := MessagesAfterLastCompactBoundary(conv)
	if len(slice) != 2 {
		t.Fatalf("expected 2 msgs (latest boundary + after), got %d", len(slice))
	}
	if !IsCompactBoundary(slice[0]) {
		t.Error("slice should start at the most recent boundary")
	}
	// The Summary of the head must be the SECOND boundary, not the first.
	blocks, ok := slice[0].Content.([]types.LlmContentBlock)
	if !ok || len(blocks) == 0 {
		t.Fatal("expected typed blocks at head of slice")
	}
	if blocks[0].Summary != "second boundary" {
		t.Errorf("head summary = %q, want second boundary", blocks[0].Summary)
	}
}

// TestMessagesAfterLastCompactBoundary_NilConv exercises the defensive
// nil guard so callers don't need their own.
func TestMessagesAfterLastCompactBoundary_NilConv(t *testing.T) {
	if slice := MessagesAfterLastCompactBoundary(nil); slice != nil {
		t.Errorf("expected nil for nil conv, got %v", slice)
	}
}

// TestIsCompactBoundary_TypedAndUntypedBlocks verifies that
// IsCompactBoundary recognises the boundary in both the typed
// []LlmContentBlock shape (live runloop construction) and the []any
// shape (post-JSON-load). Persistence round-trips through
// json.Unmarshal which yields []any of map[string]any blocks.
func TestIsCompactBoundary_TypedAndUntypedBlocks(t *testing.T) {
	typed := BuildCompactBoundaryMessage(CompactMeta{Trigger: "auto"})
	if !IsCompactBoundary(typed) {
		t.Error("expected typed boundary to be recognised")
	}

	// Synthesize the post-JSON-load shape.
	untyped := types.LlmMessage{
		Role: "user",
		Content: []interface{}{
			map[string]interface{}{
				"type":    CompactBoundaryBlockType,
				"summary": "round-tripped",
			},
		},
	}
	if !IsCompactBoundary(untyped) {
		t.Error("expected untyped (post-JSON) boundary to be recognised")
	}

	// Negative: a regular text block must not match.
	regular := types.LlmMessage{
		Role:    "user",
		Content: []types.LlmContentBlock{{Type: "text", Text: "[Previous conversation summary]: foo"}},
	}
	if IsCompactBoundary(regular) {
		t.Error("regular text block must NOT match (substring marker is intentionally not recognised)")
	}
}

// TestPostCompactReset_ClearsTokenCache verifies the seam centralises
// invalidateTokenCache. Cache invariants are pinned by the surrounding
// compaction tests in conversation_compaction_test.go; this case
// targets the PostCompactReset entry point directly.
func TestPostCompactReset_ClearsTokenCache(t *testing.T) {
	conv := CreateConversation("post-reset", "", "test")
	conv.LastInputTokens = 12345
	conv.LastInputTokensMsgCount = 9

	PostCompactReset(conv)

	if conv.LastInputTokens != 0 {
		t.Errorf("LastInputTokens = %d after PostCompactReset, want 0", conv.LastInputTokens)
	}
	if conv.LastInputTokensMsgCount != 0 {
		t.Errorf("LastInputTokensMsgCount = %d after PostCompactReset, want 0", conv.LastInputTokensMsgCount)
	}
}

// TestPostCompactReset_NilSafe pins the documented nil-safety guarantee.
func TestPostCompactReset_NilSafe(t *testing.T) {
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("PostCompactReset(nil) panicked: %v", r)
		}
	}()
	PostCompactReset(nil)
}
