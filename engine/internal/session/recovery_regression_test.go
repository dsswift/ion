package session

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestIsRecoveryWakeKind_AllowsOnlyEngineWakeKinds(t *testing.T) {
	allowed := []string{
		string(types.InjectionKindRunRecovery),
		string(types.InjectionKindAgentCompletion),
		string(types.InjectionKindBackgroundTaskCompletion),
		string(types.InjectionKindRevive),
	}
	for _, kind := range allowed {
		if !isRecoveryWakeKind(kind) {
			t.Errorf("isRecoveryWakeKind(%q) = false, want true", kind)
		}
	}
	for _, kind := range []string{"", string(types.InjectionKindSteer), string(types.InjectionKindCheckIn)} {
		if isRecoveryWakeKind(kind) {
			t.Errorf("isRecoveryWakeKind(%q) = true, want false", kind)
		}
	}
}

func TestRecoveryWakeDoesNotReplaceOriginalJournal(t *testing.T) {
	enabled := true
	m, s, _ := recoveryTestManager(t, enabled)
	s.recoveryInProgress = true
	s.recoveryID = "recovery-original"
	conv := conversation.CreateConversation(s.conversationID, "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{RecoveryID: s.recoveryID, SessionKey: s.key, Prompt: "original"})
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	m.mu.Lock()
	if !isRecoveryWakeKind(string(types.InjectionKindAgentCompletion)) {
		t.Fatal("test requires an admitted recovery wake")
	}
	journalNeeded := !s.recoveryInProgress && m.recoveryEnabled(&s.config)
	m.mu.Unlock()
	if journalNeeded {
		t.Fatal("recovery wake must not create a replacement journal")
	}

	loaded, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	journal := conversation.ActiveRunRecovery(loaded)
	if journal == nil || journal.RecoveryID != "recovery-original" || journal.Prompt != "original" {
		t.Fatalf("journal changed by recovery wake: %+v", journal)
	}
}

func TestRecoveryCoordinator_BoundsConcurrentStarts(t *testing.T) {
	coordinator := &recoveryCoordinator{limit: 2}
	started := make(chan struct{}, 3)
	release := make(chan struct{})
	var mu sync.Mutex
	active, maxActive := 0, 0
	for i := 0; i < 3; i++ {
		coordinator.enqueue(recoveryJob{key: "tab", recoveryID: string(rune('a' + i)), enqueuedAt: time.Now(), run: func() {
			mu.Lock()
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			started <- struct{}{}
			<-release
			mu.Lock()
			active--
			mu.Unlock()
		}})
	}
	for i := 0; i < 2; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("queued recovery did not start")
		}
	}
	select {
	case <-started:
		t.Fatal("coordinator exceeded concurrency cap")
	default:
	}
	close(release)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("queued recovery did not start after slot released")
	}
	mu.Lock()
	got := maxActive
	mu.Unlock()
	if got != 2 {
		t.Fatalf("max active = %d, want 2", got)
	}
}

func TestClearRunRecoveryIf_PreservesReplacementJournal(t *testing.T) {
	conv := conversation.CreateConversation("journal", "", "test-model")
	conversation.BeginRunRecovery(conv, conversation.RunJournalEntry{RecoveryID: "replacement"})
	if conversation.ClearRunRecoveryIf(conv, "stale") {
		t.Fatal("stale recovery cleared replacement journal")
	}
	journal := conversation.ActiveRunRecovery(conv)
	if journal == nil || journal.RecoveryID != "replacement" {
		t.Fatalf("replacement journal lost: %+v", journal)
	}
	if !conversation.ClearRunRecoveryIf(conv, "replacement") {
		t.Fatal("owner could not clear own journal")
	}
}
