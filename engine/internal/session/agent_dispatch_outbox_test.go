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

// TestSendAbort_DisposesRootDispatchCompletions proves a full stop owns both
// sides of a root dispatch: results already awaiting delivery and the terminal
// callback that can arrive after recall. Without the identity fence, the latter
// re-enqueues a prompt after the operator has stopped all work.
func TestSendAbort_DisposesRootDispatchCompletions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	const key = "root-dispatch-stop"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.requestID = "busy"
	s.maxQueueDepth = 0
	conversationID := s.conversationID
	mgr.mu.Unlock()

	const dispatchID = "dispatch-recalled-1"
	// runChild deregisters before its root callback. Model that precise gap:
	// the registry is already empty while the session still owns the callback.
	s.rootDispatchIDs = map[string]struct{}{dispatchID: {}}
	mgr.deliverRootDispatchResult(key, extension.DispatchAgentResult{
		Name: "reviewer", DispatchID: "dispatch-queued-before-stop", Output: "queued",
	})
	if got := len(loadRootDispatchOutbox(conversationID)); got != 1 {
		t.Fatalf("outbox count before stop = %d, want 1", got)
	}

	mgr.SendAbort(key)
	if got := len(s.dispatchRegistry.ActiveIDs()); got != 0 {
		t.Fatalf("live dispatches after stop = %d, want 0", got)
	}
	if got := len(loadRootDispatchOutbox(conversationID)); got != 0 {
		t.Fatalf("outbox count after stop = %d, want 0", got)
	}

	// This mirrors the recalled child's late terminal callback. It must not
	// restore the durable outbox or enqueue another root prompt.
	mgr.deliverRootDispatchResult(key, extension.DispatchAgentResult{
		Name: "reviewer", DispatchID: dispatchID, Output: "recalled",
		ExitCode: extcontextExitCodeRecalled,
	})
	if got := len(loadRootDispatchOutbox(conversationID)); got != 0 {
		t.Fatalf("outbox count after late recalled completion = %d, want 0", got)
	}
	mgr.mu.RLock()
	queued := len(mgr.sessions[key].rootDispatchCompletions)
	mgr.mu.RUnlock()
	if queued != 0 {
		t.Fatalf("in-memory completions after late recalled completion = %d, want 0", queued)
	}
}
