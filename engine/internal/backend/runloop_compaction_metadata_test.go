package backend

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestReactiveCompactionPreservesLoadedIdentity(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	conv := conversation.CreateConversation("loaded-reactive-identity", "", "test-model")
	body := strings.Repeat("tool output ", 120)
	for i := 0; i < 6; i++ {
		conversation.AddUserMessage(conv, "prompt")
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "calling tool"}}, types.LlmUsage{})
		isError := false
		conversation.AddToolResults(conv, []conversation.ToolResultEntry{{ToolUseID: "", Content: body, IsError: isError}})
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, types.LlmUsage{})
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := conversation.Load(conv.ID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	last := len(loaded.Messages) - 1
	loaded.Messages[last].Usage = &types.LlmUsage{InputTokens: 180_000}
	loaded = func() *conversation.Conversation {
		loaded.Messages = conversation.SanitizeMessages(loaded.Messages)
		return loaded
	}()
	for i, message := range loaded.Messages {
		if message.EntryID == "" {
			t.Fatalf("sanitized loaded message %d lost entry identity", i)
		}
	}

	backend := NewApiBackend()
	run := &activeRun{requestID: "loaded-reactive-identity", conv: loaded}
	params := testCP()
	params.summaryEnabled = false
	if !backend.compactReactive(context.Background(), run, loaded, RunHooks{}, 200_000, 1, params) {
		t.Fatal("compactReactive returned false")
	}
	if len(loaded.Messages) < 2 {
		t.Fatalf("compaction retained %d messages, want boundary plus protected suffix", len(loaded.Messages))
	}
	if !conversation.IsCompactBoundary(loaded.Messages[0]) {
		t.Fatal("hard compaction did not produce compact boundary")
	}
	for index, message := range loaded.Messages[1:] {
		if message.EntryID == "" {
			t.Fatalf("retained message %d lost identity after compaction", index)
		}
	}
}
