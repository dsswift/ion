package conversation

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestCommitCompaction_PersistsExactKeptSuffix(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("commit-compact", "", "test-model")

	AddUserMessage(conv, "old question")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "old answer"}}, types.LlmUsage{})
	AddUserMessageWithInvocation(conv, "expanded slash instructions", SlashInvocation{Command: "/review", Args: "x", Source: "ion"})
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "slash answer"}}, types.LlmUsage{})
	firstKept := AddUserMessage(conv, "recent question")
	AddToolResults(conv, []ToolResultEntry{{ToolUseID: "tool-1", Content: "recent tool output"}})
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "recent answer"}}, types.LlmUsage{})
	AddTransientUserMessage(conv, "transient reminder")

	if firstKept == nil {
		t.Fatal("first kept entry missing")
	}
	cut := TokenBudgetCut{CutIndex: 4, Dropped: 4}
	boundary := BuildCompactBoundaryMessage(CompactMeta{Trigger: "user", Summary: "summary"})
	gotID, err := CommitCompaction(conv, cut, CompactionData{Summary: "summary", Strategy: "user"}, boundary)
	if err != nil {
		t.Fatalf("CommitCompaction: %v", err)
	}
	if gotID != firstKept.ID {
		t.Fatalf("first kept id = %q, want %q", gotID, firstKept.ID)
	}
	if len(conv.Messages) != 4 || !IsCompactBoundary(conv.Messages[0]) {
		t.Fatalf("active messages = %+v, want boundary + 3 persisted recent messages", conv.Messages)
	}
	if conv.Messages[1].EntryID != firstKept.ID {
		t.Fatalf("first retained EntryID = %q, want %q", conv.Messages[1].EntryID, firstKept.ID)
	}
	for _, m := range conv.Messages {
		if m.EntryID == "" {
			t.Fatalf("committed active path contains transient/unidentified message: %+v", m)
		}
	}

	// Old history remains in the tree for display/search, including raw slash
	// provenance, while active LLM context starts at the boundary.
	if len(conv.Entries) != 8 {
		t.Fatalf("entry count = %d, want 8 (7 original + compaction)", len(conv.Entries))
	}

	want := append([]types.LlmMessage(nil), conv.Messages...)
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	var wantShape, gotShape interface{}
	wantBytes, _ := json.Marshal(want)
	gotBytes, _ := json.Marshal(loaded.Messages)
	_ = json.Unmarshal(wantBytes, &wantShape)
	_ = json.Unmarshal(gotBytes, &gotShape)
	if !reflect.DeepEqual(gotShape, wantShape) {
		t.Fatalf("save/load changed compacted context\n got: %s\nwant: %s", gotBytes, wantBytes)
	}
}

func TestCommitCompaction_FailsClosedOnUnknownEntry(t *testing.T) {
	conv := CreateConversation("bad-commit", "", "test")
	AddUserMessage(conv, "one")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "two"}}, types.LlmUsage{})
	conv.Messages[1].EntryID = "missing"
	entriesBefore := len(conv.Entries)
	_, err := CommitCompaction(conv, TokenBudgetCut{CutIndex: 1, Dropped: 1}, CompactionData{}, BuildCompactBoundaryMessage(CompactMeta{}))
	if err == nil {
		t.Fatal("expected unknown retained entry error")
	}
	if len(conv.Entries) != entriesBefore {
		t.Fatalf("failed commit mutated entries: %d -> %d", entriesBefore, len(conv.Entries))
	}
}
