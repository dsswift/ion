package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
)

// TestDispatchConversationID_SurvivesRestartForRunningDispatch pins the
// restart path of a lineage-scoped conversation read. A dispatch that was
// still running when the engine process died has only its registration record
// and the conversation ID written while it ran. A registry rebuilt from those
// records must still tie the conversation to its dispatch tree, so the parent
// can read the lost child's partial work, and must tie nothing else to it.
func TestDispatchConversationID_SurvivesRestartForRunningDispatch(t *testing.T) {
	m, s, _ := lossTestEnv(t, "conv-read-restart", nil)

	m.persistDispatchRegistered(s.key, s.conversationID, "d-lead", "lead", "Lead", "plan", "test-model", "", 1)
	m.persistDispatchRegistered(s.key, s.conversationID, "d-worker", "worker", "Worker", "build", "test-model", "d-lead", 2)
	m.persistDispatchRegistered(s.key, s.conversationID, "d-other", "other", "Other", "review", "test-model", "", 1)
	m.persistDispatchConversationID(s.conversationID, "d-lead", "conv-lead")
	m.persistDispatchConversationID(s.conversationID, "d-worker", "conv-worker")
	m.persistDispatchConversationID(s.conversationID, "d-other", "conv-other")

	// The engine restarts: a new registry knows only what the file holds.
	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	restarted := extcontext.NewDispatchRegistry()
	restarted.SeedHistory(dispatchHistoryFromConversation(conv, time.Now()))

	worker, ok := restarted.ResolveOwnedConversation("", "conv-worker", "")
	if !ok || worker.DispatchID != "d-worker" || worker.Status != extcontext.DispatchStatusLost || !worker.Terminal {
		t.Fatalf("root read of the lost grandchild after restart = %+v, ok %v", worker, ok)
	}
	if _, ok := restarted.ResolveOwnedConversation("d-lead", "conv-worker", ""); !ok {
		t.Error("persisted ancestry does not authorize the parent dispatch after restart")
	}
	if _, ok := restarted.ResolveOwnedConversation("d-other", "conv-worker", ""); ok {
		t.Error("a sibling branch was authorized after restart")
	}
	if _, ok := restarted.ResolveOwnedConversation("", "conv-with-no-persisted-dispatch", ""); ok {
		t.Error("a conversation with no persisted ancestry was authorized after restart")
	}
}
