package conversation

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRunJournalRoundTripInConversationHeader(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("recovery-roundtrip", "", "test-model")
	entry := AddUserMessage(conv, "finish the migration")
	BeginRunRecovery(conv, RunJournalEntry{
		RecoveryID: "recovery-1", SessionKey: "tab-1", Prompt: "finish the migration",
		UserEntryID: entry.ID, Overrides: json.RawMessage(`{"model":"test-model"}`),
	})
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}
	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	journal := ActiveRunRecovery(loaded)
	if journal == nil {
		t.Fatal("active run journal missing after round trip")
	}
	if journal.RecoveryID != "recovery-1" || journal.UserEntryID != entry.ID {
		t.Fatalf("journal = %+v", journal)
	}
}

func TestRunJournalClearPersists(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("recovery-clear", "", "test-model")
	BeginRunRecovery(conv, RunJournalEntry{RecoveryID: "recovery-2", SessionKey: "tab-2", Prompt: "continue"})
	if err := Save(conv, dir); err != nil {
		t.Fatalf("initial Save: %v", err)
	}
	ClearRunRecovery(conv)
	if err := Save(conv, dir); err != nil {
		t.Fatalf("clear Save: %v", err)
	}
	loaded, err := Load(conv.ID, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if ActiveRunRecovery(loaded) != nil {
		t.Fatal("cleared active run journal survived reload")
	}
}

func TestRunRecoveryContinuationIsMachineAuthored(t *testing.T) {
	conv := CreateConversation("recovery-continuation", "", "test-model")
	entry := AddRecoveryContinuation(conv)
	if entry == nil {
		t.Fatal("recovery continuation entry missing")
	}
	data, ok := entry.Data.(MessageData)
	if !ok {
		t.Fatalf("entry data = %T", entry.Data)
	}
	if data.InjectionKind != string(types.InjectionKindRunRecovery) || !data.MachineAuthored {
		t.Fatalf("recovery continuation classification = %+v", data)
	}
}

func TestMarkRunRecoveryAttempt(t *testing.T) {
	conv := CreateConversation("recovery-attempt", "", "test-model")
	BeginRunRecovery(conv, RunJournalEntry{RecoveryID: "recovery-3", SessionKey: "tab-3", Prompt: "continue"})
	journal := MarkRunRecoveryAttempt(conv)
	if journal == nil || journal.AttemptCount != 1 {
		t.Fatalf("journal = %+v, want one attempt", journal)
	}
}
