package backend

// live_conversation_ownership_test.go — the backend half of conversation
// ownership. conversation/live_test.go proves the registry mechanism; this
// proves the run loop actually claims ownership and, critically, that
// removeRun is what ends it.
//
// The ordering matters more than it looks. Ownership must survive until the
// run leaves activeRuns, because FlushConversations can save run.conv for as
// long as the run is reachable. Releasing earlier (a defer inside runLoop,
// which runs before the deferred removeRun) would reopen the exact window the
// registration exists to close.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
)

func TestRemoveRun_ReleasesConversationOwnership(t *testing.T) {
	dir := t.TempDir()
	b := NewApiBackend()
	const requestID = "req-live-release"

	conv := conversation.CreateConversation("own-release", "system", "test-model")
	conversation.AddUserMessage(conv, "hello")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}

	run := &activeRun{requestID: requestID, conv: conv}
	run.releaseLive = conversation.RegisterLive(conv.ID, conv)
	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	// While the run is registered, another writer must land on the live object.
	if err := conversation.UpdateOnDisk(conv.ID, dir, func(c *conversation.Conversation) (bool, error) {
		if c != conv {
			t.Error("writer got a disk copy while the run owned the conversation")
		}
		return false, nil
	}); err != nil {
		t.Fatalf("UpdateOnDisk while owned: %v", err)
	}

	b.removeRun(requestID)

	// After removeRun the object is unreachable, so writers must load from disk.
	if err := conversation.UpdateOnDisk(conv.ID, dir, func(c *conversation.Conversation) (bool, error) {
		if c == conv {
			t.Error("ownership outlived removeRun; writers still target the run's object")
		}
		return false, nil
	}); err != nil {
		t.Fatalf("UpdateOnDisk after removeRun: %v", err)
	}
}

// TestRemoveRun_ReleaseIsSafeWithoutRegistration covers the paths that never
// reach the registration point — an image-model run, or a run that fails
// provider resolution before loading a conversation.
func TestRemoveRun_ReleaseIsSafeWithoutRegistration(t *testing.T) {
	b := NewApiBackend()
	const requestID = "req-no-registration"

	b.mu.Lock()
	b.activeRuns[requestID] = &activeRun{requestID: requestID}
	b.mu.Unlock()

	b.removeRun(requestID) // must not panic on a nil releaseLive

	b.mu.Lock()
	_, stillThere := b.activeRuns[requestID]
	b.mu.Unlock()
	if stillThere {
		t.Error("run was not removed")
	}
}
