package conversation

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestCommitCompactionRejectsUnidentifiedPersistedMessage(t *testing.T) {
	conv := CreateConversation("missing-identity", "", "model")
	AddUserMessage(conv, strings.Repeat("old ", 100))
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: strings.Repeat("reply ", 100)}}, types.LlmUsage{})
	AddUserMessage(conv, "recent")
	entriesBefore := append([]SessionEntry(nil), conv.Entries...)
	leafBefore := CurrentLeafID(conv)

	conv.Messages[2].EntryID = ""
	_, err := CommitCompaction(conv, TokenBudgetCut{CutIndex: 1, Dropped: 1}, CompactionData{}, BuildCompactBoundaryMessage(CompactMeta{}))
	if err == nil || !strings.Contains(err.Error(), "no entry identity") {
		t.Fatalf("CommitCompaction error = %v, want missing identity rejection", err)
	}
	if len(conv.Entries) != len(entriesBefore) || CurrentLeafID(conv) != leafBefore {
		t.Fatal("failed compaction mutated tree topology")
	}
}

func TestCommitMicroCompactionPersistsContentWithoutBoundary(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("micro-commit", "", "model")
	AddUserMessage(conv, "prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "tool_use", ID: "tool", Name: "Read", Input: map[string]any{}}}, types.LlmUsage{})
	isError := false
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "tool", Content: strings.Repeat("large output ", 40), IsError: isError}})
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer"}}, types.LlmUsage{})
	AddUserMessage(conv, "follow-up")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "follow-up answer"}}, types.LlmUsage{})

	if cleared := MicroCompact(conv, 1); cleared != 1 {
		t.Fatalf("MicroCompact cleared %d blocks, want 1", cleared)
	}
	if err := CommitMicroCompaction(conv); err != nil {
		t.Fatalf("CommitMicroCompaction: %v", err)
	}
	for _, entry := range conv.Entries {
		if entry.Type == EntryCompaction {
			t.Fatal("micro-only compaction inserted an EntryCompaction boundary")
		}
	}
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	reloaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(reloaded.Messages) != len(conv.Messages) {
		t.Fatalf("reloaded messages = %d, want %d", len(reloaded.Messages), len(conv.Messages))
	}
	foundCleared := false
	for _, message := range reloaded.Messages {
		for _, block := range contentToBlockSlice(message.Content) {
			foundCleared = foundCleared || block.Content == ClearedToolResultSentinel
		}
	}
	if !foundCleared {
		t.Fatal("persisted micro compaction did not retain cleared tool-result sentinel")
	}
}

func TestCommitMicroCompactionPreservesHardCompactionBoundary(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("hard-then-micro", "", "model")
	AddUserMessage(conv, "old prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "old answer"}}, types.LlmUsage{})
	AddUserMessage(conv, "retained prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "tool_use", ID: "tool", Name: "Read", Input: map[string]any{}}}, types.LlmUsage{})
	isError := false
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "tool", Content: strings.Repeat("large output ", 40), IsError: isError}})
	AddUserMessage(conv, "recent prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "recent answer"}}, types.LlmUsage{})

	if _, err := CommitCompaction(conv, TokenBudgetCut{CutIndex: 2, Dropped: 2}, CompactionData{}, BuildCompactBoundaryMessage(CompactMeta{})); err != nil {
		t.Fatalf("CommitCompaction: %v", err)
	}
	if !IsCompactBoundary(conv.Messages[0]) {
		t.Fatal("hard compaction did not add a boundary to active context")
	}
	if cleared := MicroCompact(conv, 1); cleared != 1 {
		t.Fatalf("MicroCompact cleared %d blocks, want 1", cleared)
	}
	if err := CommitMicroCompaction(conv); err != nil {
		t.Fatalf("CommitMicroCompaction after hard compaction: %v", err)
	}
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	reloaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(reloaded.Messages) == 0 || !IsCompactBoundary(reloaded.Messages[0]) {
		t.Fatal("reloaded conversation lost its hard-compaction boundary")
	}
	foundCleared := false
	for _, message := range reloaded.Messages {
		for _, block := range contentToBlockSlice(message.Content) {
			foundCleared = foundCleared || block.Content == ClearedToolResultSentinel
		}
	}
	if !foundCleared {
		t.Fatal("reloaded conversation lost micro-compacted tool output")
	}
}

func TestCommitMicroCompactionRejectsMessageUsingCompactionEntryID(t *testing.T) {
	conv := CreateConversation("micro-identity", "", "model")
	AddUserMessage(conv, "old prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "old answer"}}, types.LlmUsage{})
	AddUserMessage(conv, "retained prompt")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "retained answer"}}, types.LlmUsage{})

	if _, err := CommitCompaction(conv, TokenBudgetCut{CutIndex: 2, Dropped: 2}, CompactionData{}, BuildCompactBoundaryMessage(CompactMeta{})); err != nil {
		t.Fatalf("CommitCompaction: %v", err)
	}
	conv.Messages[1].EntryID = conv.Messages[0].EntryID

	err := CommitMicroCompaction(conv)
	if err == nil || !strings.Contains(err.Error(), "message entry") || !strings.Contains(err.Error(), "want message") {
		t.Fatalf("CommitMicroCompaction error = %v, want regular-message identity rejection", err)
	}
}
