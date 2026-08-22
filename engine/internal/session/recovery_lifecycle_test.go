package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestNewSessionHasNoRecoveryLifecycleState(t *testing.T) {
	_, s, _ := recoveryTestManager(t, true)
	if s.recoveryInProgress || s.recoveryID != "" || s.recoveryAttempt != 0 || s.recoveryMaxAttempts != 0 {
		t.Fatalf("new session has recovery state: %+v", s)
	}
}

func TestHandleRunExit_RecoveryCleanupClearsOwnedLifecycle(t *testing.T) {
	m, s, _ := recoveryTestManager(t, true)
	var eventsMu sync.Mutex
	var events []types.EngineEvent
	m.OnEvent(func(_ string, event types.EngineEvent) {
		if event.Type == "engine_run_recovery" {
			eventsMu.Lock()
			events = append(events, event)
			eventsMu.Unlock()
		}
	})
	const runID = "recovery-run-exit"
	const recoveryID = "recovery-exit"

	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{
		RecoveryID:   recoveryID,
		SessionKey:   s.key,
		Prompt:       "continue",
		AttemptCount: 1,
	})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed recovery journal: %v", err)
	}

	m.mu.Lock()
	s.recoveryInProgress = true
	s.recoveryID = recoveryID
	s.recoveryAttempt = 1
	s.recoveryMaxAttempts = 3
	s.requestID = runID
	m.bindRunLocked(runID, s.key)
	m.mu.Unlock()

	code := 0
	m.handleRunExit(runID, &code, nil, "")

	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("load recovery journal: %v", err)
	}
	if journal := conversation.ActiveRunRecovery(loaded); journal != nil {
		t.Fatalf("active recovery journal = %+v, want cleared", journal)
	}

	m.mu.RLock()
	inProgress, gotID := s.recoveryInProgress, s.recoveryID
	attempt, maxAttempts := s.recoveryAttempt, s.recoveryMaxAttempts
	m.mu.RUnlock()
	if inProgress || gotID != "" || attempt != 0 || maxAttempts != 0 {
		t.Fatalf("recovery lifecycle not cleared: inProgress=%v id=%q attempt=%d maxAttempts=%d", inProgress, gotID, attempt, maxAttempts)
	}

	eventsMu.Lock()
	defer eventsMu.Unlock()
	for _, event := range events {
		if event.Type == "engine_run_recovery" && event.RunRecoveryID == recoveryID && event.RunRecoveryPhase == "completed" && event.RunRecoveryAttempt == 1 && event.RunRecoveryMaxAttempts == 3 {
			return
		}
	}
	t.Fatalf("missing completed recovery event for %q: %+v", recoveryID, events)
}
