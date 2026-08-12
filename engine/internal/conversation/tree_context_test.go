package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestCompactBoundaryTreeRebuildPreservesAllPersistedMetadata(t *testing.T) {
	conv := CreateConversation("boundary-metadata", "", "model")
	AddUserMessage(conv, "before")
	AppendEntry(conv, EntryCompaction, CompactionData{
		Summary:            "summary",
		MessagesSummarized: 3,
		MessagesBefore:     10,
		MessagesAfter:      8,
		ClearedBlocks:      4,
		TokensBefore:       90_000,
		Strategy:           "reactive",
		FactCount:          2,
		RecentFiles:        []string{"/src/main.go"},
	})
	AddUserMessage(conv, "after")

	messages := BuildContextPath(conv)
	if len(messages) != 2 || !IsCompactBoundary(messages[0]) {
		t.Fatalf("rebuilt messages = %#v, want boundary plus suffix", messages)
	}
	blocks := contentToBlockSlice(messages[0].Content)
	block := blocks[0]
	if block.Trigger != "reactive" || block.MessagesSummarized != 3 || block.MessagesBefore != 10 || block.MessagesAfter != 8 || block.ClearedBlocks != 4 || block.TokensBefore != 90_000 || block.FactCount != 2 {
		t.Errorf("rebuilt block metadata = %+v", block)
	}
	if len(block.RecentFiles) != 1 || block.RecentFiles[0] != "/src/main.go" {
		t.Errorf("rebuilt recent files = %#v", block.RecentFiles)
	}
}

func TestBuildContextPathClearKeepsFullTranscriptOutOfProviderContext(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("clear-dual-projection", "", "model")
	AddUserMessage(conv, "before clear")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "before answer"}}, types.LlmUsage{InputTokens: 100})
	conv.Messages = nil
	AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: "/clear", SlashCommand: "/clear", DisplayOnly: true})
	AppendEntry(conv, EntryCleared, ClearedData{})
	AddUserMessage(conv, "after clear")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "after answer"}}, types.LlmUsage{InputTokens: 50})
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("provider messages = %d, want only post-clear pair", len(loaded.Messages))
	}
	for _, message := range loaded.Messages {
		text := messageText(message)
		if text == "before clear" || text == "before answer" || text == "/clear" {
			t.Fatalf("provider context leaked clear-boundary content %q", text)
		}
	}

	transcript, err := LoadMessages(conv.ID, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}
	var before, clearPill, clearMarker, after bool
	for _, row := range transcript {
		before = before || row.Content == "before clear"
		clearPill = clearPill || row.SlashCommand == "/clear"
		clearMarker = clearMarker || row.MarkerKind == "clear"
		after = after || row.Content == "after clear"
	}
	if !before || !clearPill || !clearMarker || !after {
		t.Fatalf("transcript projection lost history: before=%t clearPill=%t clearMarker=%t after=%t", before, clearPill, clearMarker, after)
	}
}

func messageText(message types.LlmMessage) string {
	blocks := contentToBlockSlice(message.Content)
	if len(blocks) == 1 {
		return blocks[0].Text
	}
	return ""
}
