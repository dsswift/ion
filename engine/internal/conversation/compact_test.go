package conversation

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// CompactToTokenBudget
// ---------------------------------------------------------------------------

func TestCompactToTokenBudget_Basic(t *testing.T) {
	// Create a conversation with messages of known sizes.
	conv := &Conversation{
		Messages: make([]types.LlmMessage, 0),
	}

	// Add 20 user/assistant turn pairs, each turn pair ~1000 tokens.
	for i := 0; i < 20; i++ {
		// ~500 tokens per message (2000 chars / 4)
		userText := strings.Repeat("a", 2000)
		assistText := strings.Repeat("b", 2000)
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: userText},
			types.LlmMessage{Role: "assistant", Content: assistText},
		)
	}

	// Target 5000 tokens — should keep roughly 5 turn pairs (10 messages).
	CompactToTokenBudget(conv, 5000, 2, 1.0)

	// Should have dropped a significant number of messages.
	if len(conv.Messages) >= 40 {
		t.Errorf("expected messages to be reduced, got %d", len(conv.Messages))
	}
	// Should have kept at least minKeepTurns (2) = 4 messages.
	if len(conv.Messages) < 4 {
		t.Errorf("expected at least 4 messages (minKeepTurns=2), got %d", len(conv.Messages))
	}
	// First message should be a user message (turn boundary).
	if conv.Messages[0].Role != "user" {
		t.Errorf("first message should be user, got %q", conv.Messages[0].Role)
	}
}

func TestCompactToTokenBudget_MinKeepTurns(t *testing.T) {
	conv := &Conversation{}

	// 3 massive turns — each >10K tokens.
	for i := 0; i < 3; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: strings.Repeat("x", 40000)},
			types.LlmMessage{Role: "assistant", Content: strings.Repeat("y", 40000)},
		)
	}

	// Target only 100 tokens — way below what 2 turns need.
	// But minKeepTurns=2 should preserve at least 2 user turns.
	CompactToTokenBudget(conv, 100, 2, 1.0)

	// Count remaining user messages.
	userCount := 0
	for _, m := range conv.Messages {
		if m.Role == "user" {
			userCount++
		}
	}
	if userCount < 2 {
		t.Errorf("expected at least 2 user turns (minKeepTurns), got %d", userCount)
	}
}

func TestCompactToTokenBudget_TurnBoundary(t *testing.T) {
	conv := &Conversation{
		Messages: []types.LlmMessage{
			{Role: "user", Content: strings.Repeat("a", 2000)},
			{Role: "assistant", Content: strings.Repeat("b", 2000)},
			{Role: "user", Content: strings.Repeat("c", 2000)},
			{Role: "assistant", Content: strings.Repeat("d", 2000)},
			{Role: "user", Content: strings.Repeat("e", 2000)},
			{Role: "assistant", Content: strings.Repeat("f", 2000)},
		},
	}

	// Target small enough to drop some, but first msg must be "user".
	CompactToTokenBudget(conv, 1500, 1, 1.0)

	if len(conv.Messages) > 0 && conv.Messages[0].Role != "user" {
		t.Errorf("first message must be user (turn boundary), got %q", conv.Messages[0].Role)
	}
}

func TestCompactToTokenBudget_NothingToCompact(t *testing.T) {
	conv := &Conversation{
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hi"},
			{Role: "assistant", Content: "hello"},
		},
	}

	original := len(conv.Messages)
	CompactToTokenBudget(conv, 100000, 2, 1.0)

	if len(conv.Messages) != original {
		t.Errorf("should not compact when under budget: got %d, want %d", len(conv.Messages), original)
	}
}

func TestCompactToTokenBudget_WithPadding(t *testing.T) {
	conv := &Conversation{}
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: strings.Repeat("a", 2000)},
			types.LlmMessage{Role: "assistant", Content: strings.Repeat("b", 2000)},
		)
	}

	// With 1.33 padding, effective estimate is 33% higher, so fewer messages kept.
	CompactToTokenBudget(conv, 5000, 2, 1.33)
	withPadding := len(conv.Messages)

	// Reset and try without padding.
	conv.Messages = make([]types.LlmMessage, 0)
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: strings.Repeat("a", 2000)},
			types.LlmMessage{Role: "assistant", Content: strings.Repeat("b", 2000)},
		)
	}
	CompactToTokenBudget(conv, 5000, 2, 1.0)
	withoutPadding := len(conv.Messages)

	// With padding, should keep fewer messages (or equal).
	if withPadding > withoutPadding {
		t.Errorf("padding should keep fewer messages: withPadding=%d, withoutPadding=%d", withPadding, withoutPadding)
	}
}

func TestCompactToTokenBudget_ZeroTarget(t *testing.T) {
	conv := &Conversation{
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hi"},
		},
	}
	original := len(conv.Messages)
	CompactToTokenBudget(conv, 0, 2, 1.0)
	if len(conv.Messages) != original {
		t.Errorf("zero target should be no-op: got %d, want %d", len(conv.Messages), original)
	}
}

func TestCompactToTokenBudget_DefaultParams(t *testing.T) {
	conv := &Conversation{}
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: strings.Repeat("a", 2000)},
			types.LlmMessage{Role: "assistant", Content: strings.Repeat("b", 2000)},
		)
	}

	// Zero minKeepTurns and padding should use defaults.
	CompactToTokenBudget(conv, 1000, 0, 0)

	// Should have kept at least DefaultMinKeepTurns.
	userCount := 0
	for _, m := range conv.Messages {
		if m.Role == "user" {
			userCount++
		}
	}
	if userCount < DefaultMinKeepTurns {
		t.Errorf("default minKeepTurns should apply: got %d user turns, want >= %d", userCount, DefaultMinKeepTurns)
	}
}

// ---------------------------------------------------------------------------
// MicroCompact — aggressive keepTurns
// ---------------------------------------------------------------------------

func TestMicroCompact_AggressiveKeep(t *testing.T) {
	conv := &Conversation{}

	// 10 turns with large tool results.
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{
				{Type: "tool_result", Content: strings.Repeat("x", 200)},
			}},
			types.LlmMessage{Role: "assistant", Content: []types.LlmContentBlock{
				{Type: "text", Text: "ok"},
			}},
		)
	}

	// keepTurns=3 should clear tool results from the oldest 7 turns.
	cleared := MicroCompact(conv, 3)
	if cleared == 0 {
		t.Error("expected some tool results to be cleared")
	}

	// Last 3 turns should still have their tool results intact.
	// With 10 turns = 20 messages, last 3 user turns are at indices 14, 16, 18.
	for i := len(conv.Messages) - 6; i < len(conv.Messages); i += 2 {
		msg := conv.Messages[i]
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for _, b := range blocks {
			if b.Type == "tool_result" && b.Content == "[cleared]" {
				t.Errorf("message %d should NOT be cleared (within keepTurns=3)", i)
			}
		}
	}
}

// TestMicroCompact_Pass2Idempotent verifies that repeated micro-compaction
// passes never double-truncate an assistant text block. Without the
// HasSuffix guard, the second pass would slice the already-truncated string
// and append a second "... [truncated]" marker, mangling the text.
func TestMicroCompact_Pass2Idempotent(t *testing.T) {
	conv := &Conversation{}

	// Build enough turns that the oldest ones fall outside keepTurns and are
	// eligible for pass 2. Use tool_result blocks SHORT enough that pass 1
	// clears nothing (so pass 2 runs), and long assistant text blocks.
	longText := strings.Repeat("word ", 100) // 500 chars, well over the 200 cap
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{
				{Type: "tool_result", Content: "short"}, // < 100 chars: pass 1 skips
			}},
			types.LlmMessage{Role: "assistant", Content: []types.LlmContentBlock{
				{Type: "text", Text: longText},
			}},
		)
	}

	// First pass: pass 1 clears nothing (short tool_results), so pass 2 runs
	// and truncates the long assistant text blocks.
	firstCleared := MicroCompact(conv, 3)
	if firstCleared == 0 {
		t.Fatal("expected pass 2 to truncate at least one assistant text block")
	}

	// Capture the truncated text of the oldest assistant message (index 1).
	firstBlocks := conv.Messages[1].Content.([]types.LlmContentBlock)
	afterFirst := firstBlocks[0].Text
	if !strings.HasSuffix(afterFirst, "... [truncated]") {
		t.Fatalf("expected truncation marker after first pass, got %q", afterFirst)
	}

	// Second pass: the already-truncated blocks must be skipped. The text must
	// be byte-identical to after the first pass — no double truncation. And the
	// pass must report ZERO cleared blocks, because every eligible block was
	// already truncated. Without the HasSuffix guard, pass 2 re-processes each
	// already-truncated block and inflates the cleared count (wasted work and a
	// misleading ClearedBlocks figure on the emitted event).
	secondCleared := MicroCompact(conv, 3)
	if secondCleared != 0 {
		t.Errorf("second pass re-truncated already-truncated blocks: cleared=%d, want 0", secondCleared)
	}
	secondBlocks := conv.Messages[1].Content.([]types.LlmContentBlock)
	afterSecond := secondBlocks[0].Text
	if afterSecond != afterFirst {
		t.Errorf("second pass mutated already-truncated text:\n first=%q\nsecond=%q", afterFirst, afterSecond)
	}
	if strings.Count(afterSecond, "... [truncated]") != 1 {
		t.Errorf("expected exactly one truncation marker, got %d in %q",
			strings.Count(afterSecond, "... [truncated]"), afterSecond)
	}
}

// TestMicroCompact_ThresholdConsts pins the tool_result pass-1 boundary to the
// MicroCompactToolResultMinChars const: a block just over the threshold is
// cleared, one at or under it is left intact.
func TestMicroCompact_ThresholdConsts(t *testing.T) {
	conv := &Conversation{}

	// Oldest turn (outside keepTurns) with two tool_results: one just over the
	// min-chars threshold, one exactly at it.
	over := strings.Repeat("x", MicroCompactToolResultMinChars+1)
	atLimit := strings.Repeat("y", MicroCompactToolResultMinChars)
	conv.Messages = append(conv.Messages,
		types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{
			{Type: "tool_result", Content: over},
			{Type: "tool_result", Content: atLimit},
		}},
	)
	// Pad with recent turns so the first turn is outside keepTurns.
	for i := 0; i < 5; i++ {
		conv.Messages = append(conv.Messages,
			types.LlmMessage{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "q"}}},
			types.LlmMessage{Role: "assistant", Content: []types.LlmContentBlock{{Type: "text", Text: "a"}}},
		)
	}

	MicroCompact(conv, 3)

	blocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Content != ClearedToolResultSentinel {
		t.Errorf("block over threshold (%d chars) should be cleared, got %q",
			MicroCompactToolResultMinChars+1, blocks[0].Content)
	}
	if blocks[1].Content != atLimit {
		t.Errorf("block at threshold (%d chars) should NOT be cleared, got %q",
			MicroCompactToolResultMinChars, blocks[1].Content)
	}
}
