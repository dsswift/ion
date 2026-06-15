package providers

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestCacheControl_SkipsEmptyTextBlocks verifies that the cache_control loop
// in formatMessages does NOT attach cache_control to user messages whose
// last block is an empty text block. Anthropic rejects such requests with:
//   "cache_control cannot be set for empty text blocks"
func TestCacheControl_SkipsEmptyTextBlocks(t *testing.T) {
	p := &anthropicProvider{}
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "text", Text: ""},
		}},
	}

	result := p.formatMessages(msgs)
	if len(result) != 1 {
		t.Fatalf("want 1 message, got %d", len(result))
	}
	content, ok := result[0]["content"].([]map[string]any)
	if !ok || len(content) == 0 {
		t.Fatal("expected content blocks")
	}
	last := content[len(content)-1]
	if _, has := last["cache_control"]; has {
		t.Error("cache_control should NOT be set on an empty text block")
	}
}

// TestCacheControl_AppliedToNonEmptyText verifies that non-empty text
// blocks in user messages DO receive cache_control as before.
func TestCacheControl_AppliedToNonEmptyText(t *testing.T) {
	p := &anthropicProvider{}
	msgs := []types.LlmMessage{
		{Role: "user", Content: "hello world"},
	}

	result := p.formatMessages(msgs)
	if len(result) != 1 {
		t.Fatalf("want 1 message, got %d", len(result))
	}
	content, ok := result[0]["content"].([]map[string]any)
	if !ok || len(content) == 0 {
		t.Fatal("expected content blocks")
	}
	last := content[len(content)-1]
	if _, has := last["cache_control"]; !has {
		t.Error("cache_control should be set on a non-empty text block")
	}
}

// TestCacheControl_BudgetPreservedAcrossSkipped verifies that skipping an
// empty-text user message does NOT consume the cache budget — the budget
// is preserved for the next eligible message walking backwards.
func TestCacheControl_BudgetPreservedAcrossSkipped(t *testing.T) {
	p := &anthropicProvider{}
	// 4 user messages: the last one has empty text (should be skipped),
	// the 3 before it have non-empty text (should all get cache_control).
	msgs := []types.LlmMessage{
		{Role: "user", Content: "first"},
		{Role: "assistant", Content: "reply 1"},
		{Role: "user", Content: "second"},
		{Role: "assistant", Content: "reply 2"},
		{Role: "user", Content: "third"},
		{Role: "assistant", Content: "reply 3"},
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "text", Text: ""},
		}},
	}

	result := p.formatMessages(msgs)

	// Count how many user messages received cache_control.
	cached := 0
	for _, msg := range result {
		if msg["role"] != "user" {
			continue
		}
		content, ok := msg["content"].([]map[string]any)
		if !ok || len(content) == 0 {
			continue
		}
		last := content[len(content)-1]
		if _, has := last["cache_control"]; has {
			cached++
		}
	}
	// Budget is 3. The empty-text message is skipped (no decrement),
	// so 3 non-empty user messages should receive cache_control.
	if cached != 3 {
		t.Errorf("want 3 cached user messages, got %d", cached)
	}

	// Verify the empty-text message (last user message) does NOT have cache_control.
	lastUserIdx := -1
	for i := len(result) - 1; i >= 0; i-- {
		if result[i]["role"] == "user" {
			lastUserIdx = i
			break
		}
	}
	if lastUserIdx < 0 {
		t.Fatal("no user messages in result")
	}
	lastContent, _ := result[lastUserIdx]["content"].([]map[string]any)
	if _, has := lastContent[len(lastContent)-1]["cache_control"]; has {
		t.Error("the empty-text user message should NOT have cache_control")
	}
}

// TestCacheControl_ToolResultBlocksStillCached verifies that user messages
// whose last block is a tool_result (not text) still get cache_control.
func TestCacheControl_ToolResultBlocksStillCached(t *testing.T) {
	p := &anthropicProvider{}
	isErr := false
	msgs := []types.LlmMessage{
		{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "abc", Content: "result text", IsError: &isErr},
		}},
	}

	result := p.formatMessages(msgs)
	if len(result) != 1 {
		t.Fatalf("want 1 message, got %d", len(result))
	}
	content, ok := result[0]["content"].([]map[string]any)
	if !ok || len(content) == 0 {
		t.Fatal("expected content blocks")
	}
	last := content[len(content)-1]
	if _, has := last["cache_control"]; !has {
		t.Error("cache_control should be set on tool_result blocks")
	}
}
