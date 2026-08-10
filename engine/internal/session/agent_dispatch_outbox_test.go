package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
)

func TestRootDispatchOutboxPersistsBeforeDelivery(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	const key = "root-dispatch-outbox"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	mgr.mu.Lock()
	s := mgr.sessions[key]
	// Force SendPrompt to reject delivery so the completion must remain durable.
	s.requestID = "busy"
	s.maxQueueDepth = 0
	conversationID := s.conversationID
	mgr.mu.Unlock()

	mgr.deliverRootDispatchResult(key, extension.DispatchAgentResult{
		Name: "reviewer", DispatchID: "dispatch-reviewer-1", Output: "done",
	})
	persisted := loadRootDispatchOutbox(conversationID)
	if len(persisted) != 1 {
		t.Fatalf("persisted outbox count = %d, want 1", len(persisted))
	}
	if persisted[0].DispatchID != "dispatch-reviewer-1" {
		t.Errorf("persisted dispatch id = %q", persisted[0].DispatchID)
	}

	mgr.mu.RLock()
	inMemory := append([]rootDispatchCompletion(nil), mgr.sessions[key].rootDispatchCompletions...)
	mgr.mu.RUnlock()
	if len(inMemory) != 1 || inMemory[0].DeliveryID != persisted[0].DeliveryID {
		t.Fatalf("in-memory outbox = %#v, want durable FIFO head", inMemory)
	}
}
