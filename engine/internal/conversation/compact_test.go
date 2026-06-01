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
