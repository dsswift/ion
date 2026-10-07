package conversation

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// benchConversation builds a conversation of turns user/assistant exchanges,
// each assistant turn carrying text and one tool call answered by a tool
// result, so the fixtures exercise the block shapes a real run writes.
func benchConversation(id string, turns int) *Conversation {
	conv := CreateConversation(id, "You are a coding agent.", "bench-model")
	body := strings.Repeat("lorem ipsum dolor sit amet ", 40)
	for i := 0; i < turns; i++ {
		AddUserMessage(conv, fmt.Sprintf("question %d: %s", i, body))
		toolID := fmt.Sprintf("toolu_%04d", i)
		AddAssistantMessage(conv, []types.LlmContentBlock{
			{Type: "text", Text: "answer " + body},
			{Type: "tool_use", ID: toolID, Name: "Read", Input: map[string]any{"file_path": "/repo/file.go"}},
		}, types.LlmUsage{InputTokens: 1000 + i*100, OutputTokens: 200})
		AddUserMessage(conv, []types.LlmContentBlock{{Type: "tool_result", ToolUseID: toolID, Content: body}})
	}
	return conv
}

// BenchmarkConversationPersist is conversation.persist: one Save of a
// 100-turn conversation.
func BenchmarkConversationPersist(b *testing.B) {
	dir := b.TempDir()
	conv := benchConversation("bench-persist", 100)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := Save(conv, dir); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkConversationLoad is conversation.load: one Load of a 100-turn
// conversation from disk.
func BenchmarkConversationLoad(b *testing.B) {
	dir := b.TempDir()
	conv := benchConversation("bench-load", 100)
	if err := Save(conv, dir); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Load(conv.ID, dir); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkContextAssemble is the per-turn context build's dominant cost:
// sanitizing a 100-turn conversation's messages for the provider request.
func BenchmarkContextAssemble(b *testing.B) {
	conv := benchConversation("bench-assemble", 100)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if out := SanitizeMessages(conv.Messages); len(out) == 0 {
			b.Fatal("sanitize returned no messages")
		}
	}
}

// BenchmarkCompaction compacts a 100-turn conversation to a token budget,
// rebuilding the fixture each iteration outside the timer.
func BenchmarkCompaction(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		conv := benchConversation("bench-compact", 100)
		b.StartTimer()
		CompactToTokenBudget(conv, 20_000, 4, 0.1)
	}
}

// BenchmarkMicroCompaction clears old tool results, keeping the last turns.
func BenchmarkMicroCompaction(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		b.StopTimer()
		conv := benchConversation("bench-micro", 100)
		b.StartTimer()
		MicroCompact(conv, 4)
	}
}
