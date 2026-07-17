package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRehydrateMessageUsage(t *testing.T) {
	// Build a conversation, save it, load it, verify usage is rehydrated.
	dir := t.TempDir()
	conv := CreateConversation("rehydrate-test", "sys", "model")
	AddUserMessage(conv, "hello")
	usage := types.LlmUsage{InputTokens: 75000, OutputTokens: 2000}
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}}, usage)

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Find the assistant message
	var assistantMsg *types.LlmMessage
	for i := range loaded.Messages {
		if loaded.Messages[i].Role == "assistant" {
			assistantMsg = &loaded.Messages[i]
			break
		}
	}
	if assistantMsg == nil {
		t.Fatal("no assistant message found after load")
	}
	if assistantMsg.Usage == nil {
		t.Fatal("Usage is nil on assistant message after load — rehydration failed")
	}
	if assistantMsg.Usage.InputTokens != 75000 {
		t.Errorf("Usage.InputTokens = %d, want 75000", assistantMsg.Usage.InputTokens)
	}

	// GetContextUsage should use the rehydrated usage, not the heuristic
	info := GetContextUsage(loaded, 200000)
	if info.Estimated {
		t.Error("expected Estimated=false after load+rehydration")
	}
	if info.Tokens != 75000 {
		t.Errorf("Tokens = %d, want 75000", info.Tokens)
	}
}

func TestRehydrateMessageUsage_EmptyConv(t *testing.T) {
	conv := CreateConversation("empty", "sys", "model")
	rehydrateMessageUsage(conv) // must not panic
}

func TestRehydrateMessageUsage_NoUsageOnEntries(t *testing.T) {
	conv := CreateConversation("test", "sys", "model")
	AddUserMessage(conv, "hello")
	// Add assistant message with zero usage (pre-commit-2 legacy)
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "hi"})
	// Manually add entry without usage
	AppendEntry(conv, EntryMessage, MessageData{Role: "assistant", Content: "hi"})
	rehydrateMessageUsage(conv)
	// No panic, message Usage stays nil
	for _, m := range conv.Messages {
		if m.Role == "assistant" && m.Usage != nil {
			t.Error("expected Usage=nil for entry with no usage")
		}
	}
}
