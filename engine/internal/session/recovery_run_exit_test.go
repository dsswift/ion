package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

func seedRunExitJournal(t *testing.T, s *engineSession, recoveryID string) {
	t.Helper()
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
		RecoveryID: recoveryID,
		SessionKey: s.key,
		Prompt:     "perform durable work",
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed recovery journal: %v", err)
	}
}

func bindRunForExit(t *testing.T, m *Manager, s *engineSession, runID string) {
	t.Helper()
	m.mu.Lock()
	s.requestID = runID
	m.bindRunLocked(runID, s.key)
	m.mu.Unlock()
}

func activeJournal(t *testing.T, conversationID string) *conversation.RunJournalEntry {
	t.Helper()
	conv, err := conversation.Load(conversationID, "")
	if err != nil {
		t.Fatalf("load recovery journal: %v", err)
	}
	return conversation.ActiveRunRecovery(conv)
}

func TestHandleRunExit_OrdinaryRunClearsOwnedJournal(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	const runID = "ordinary-run-exit"
	seedRunExitJournal(t, s, runID)
	bindRunForExit(t, m, s, runID)

	code := 0
	m.handleRunExit(runID, &code, nil, "")

	if journal := activeJournal(t, s.conversationID); journal != nil {
		t.Fatalf("active ordinary-run journal = %+v, want cleared", journal)
	}
}

func TestHandleRunExit_SuspendedOrdinaryRunKeepsJournal(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	const runID = "parked-run-exit"
	seedRunExitJournal(t, s, runID)
	bindRunForExit(t, m, s, runID)

	code := 0
	signal := "suspended"
	m.handleRunExit(runID, &code, &signal, "")

	journal := activeJournal(t, s.conversationID)
	if journal == nil || journal.RecoveryID != runID {
		t.Fatalf("suspended run journal = %+v, want owner %q retained", journal, runID)
	}
}

func TestHandleRunExit_OrdinaryRunPreservesReplacementJournal(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	const runID = "ordinary-run-exit"
	const replacementID = "queued-replacement"
	seedRunExitJournal(t, s, replacementID)
	bindRunForExit(t, m, s, runID)

	code := 0
	m.handleRunExit(runID, &code, nil, "")

	journal := activeJournal(t, s.conversationID)
	if journal == nil || journal.RecoveryID != replacementID {
		t.Fatalf("replacement journal = %+v, want owner %q retained", journal, replacementID)
	}
}
