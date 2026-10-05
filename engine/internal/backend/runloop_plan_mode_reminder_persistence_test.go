package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestTurnLimitWarningIsPersisted confirms that an engine steering message
// follows the normal persist path.
func TestTurnLimitWarningIsPersisted(t *testing.T) {
	dir := t.TempDir()
	conv := conversation.CreateConversation("test-persist-warning", "", "test-model")
	conversation.AddUserMessage(conv, "Hello.")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	msgsBefore := len(conv.Messages)
	entriesBefore := len(conv.Entries)

	b := NewApiBackend()
	run := &activeRun{requestID: "test-persist"}
	opts := types.RunOptions{}

	b.injectSystemMessage(run, conv, RunHooks{}, opts, "turn_limit_warning",
		"Turn limit warning (test)", 5, 10)

	// Provider sees it.
	if got := len(conv.Messages); got != msgsBefore+1 {
		t.Errorf("turn_limit_warning: conv.Messages want %d got %d — warning not injected", msgsBefore+1, got)
	}
	// turn_limit_warning IS persisted (legitimate history entry).
	if got := len(conv.Entries); got != entriesBefore+1 {
		t.Errorf("turn_limit_warning: conv.Entries want %d got %d — warning must be persisted", entriesBefore+1, got)
	}
}

// TestSuppressSystemMessages_StillTransient confirms that SuppressSystemMessages
// keeps an engine steering message out of the entry tree.
func TestSuppressSystemMessages_StillTransient(t *testing.T) {
	dir := t.TempDir()
	conv := conversation.CreateConversation("test-suppress", "", "test-model")
	conversation.AddUserMessage(conv, "Hello.")
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	msgsBefore := len(conv.Messages)
	entriesBefore := len(conv.Entries)

	b := NewApiBackend()
	run := &activeRun{requestID: "test-suppress"}
	opts := types.RunOptions{SuppressSystemMessages: true}

	b.injectSystemMessage(run, conv, RunHooks{}, opts, "turn_limit_warning",
		"Turn limit warning (suppressed)", 5, 10)

	// Provider sees it.
	if got := len(conv.Messages); got != msgsBefore+1 {
		t.Errorf("SuppressSystemMessages: conv.Messages want %d got %d — message not injected", msgsBefore+1, got)
	}
	// SuppressSystemMessages → transient regardless of kind.
	if got := len(conv.Entries); got != entriesBefore {
		t.Errorf("SuppressSystemMessages: conv.Entries want %d got %d — must be transient", entriesBefore, got)
	}
}
