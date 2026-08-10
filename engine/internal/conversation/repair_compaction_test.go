package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRepairInvalidZeroDropCompactionRestoresProviderContext(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("bad-zero-drop", "system", "model")
	AddUserMessage(conv, "before one")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer one"}}, types.LlmUsage{InputTokens: 100})
	AddUserMessage(conv, "before two")
	resume := AddUserMessage(conv, "resume")
	if resume == nil {
		t.Fatal("missing resume entry")
	}
	resumeParent := ""
	for _, entry := range conv.Entries {
		if entry.ID == resume.ID && entry.ParentID != nil {
			resumeParent = *entry.ParentID
			break
		}
	}
	if resumeParent == "" {
		t.Fatal("resume entry missing parent")
	}
	badID := "invalid-compact"
	conv.Entries = append(conv.Entries, SessionEntry{
		ID: badID, ParentID: &resumeParent, Type: EntryCompaction, Timestamp: nowMillis(),
		Data: CompactionData{
			FirstKeptEntryID: resume.ID,
			MessagesBefore:   4,
			MessagesAfter:    5,
		},
	})
	for i := range conv.Entries {
		if conv.Entries[i].ID == resume.ID {
			conv.Entries[i].ParentID = &badID
		}
	}
	conv.Messages = []types.LlmMessage{BuildCompactBoundaryMessage(CompactMeta{}), {Role: "user", Content: "resume"}}
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	for _, entry := range loaded.Entries {
		if entry.ID == badID {
			t.Fatal("invalid zero-drop compaction survived load repair")
		}
	}
	if len(loaded.Messages) != 4 {
		t.Fatalf("provider context messages = %d, want restored 4", len(loaded.Messages))
	}
	if loaded.Messages[len(loaded.Messages)-1].EntryID != resume.ID {
		t.Errorf("last restored EntryID = %q, want resume %q", loaded.Messages[len(loaded.Messages)-1].EntryID, resume.ID)
	}
	if err := Save(loaded, dir); err != nil {
		t.Fatalf("Save repaired tree: %v", err)
	}
	reloaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("reload repaired tree: %v", err)
	}
	if len(reloaded.Messages) != 4 {
		t.Fatalf("reloaded provider context messages = %d, want 4", len(reloaded.Messages))
	}
}
