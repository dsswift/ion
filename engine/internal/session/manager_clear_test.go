package session

import (
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestSendCommand_Clear_FiresSessionStart verifies that dispatching the
// `clear` command re-fires the session_start hook on an already-loaded
// extension group. This is the load-bearing behaviour of the /clear
// checkpoint feature: the harness must get a chance to re-prime the
// now-empty conversation.
//
// In-process hook pattern adapted from engine/internal/extension/sdk_test.go
// (TestHost_InProcessExtension).
func TestSendCommand_Clear_FiresSessionStart(t *testing.T) {
	// HOME override so the engine's conversation.Save/Load (called with "")
	// writes to a tempdir and not the developer's real ~/.ion.
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-fires-session-start"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversationID so the clear branch actually runs (the engine
	// guards on conversationID != "" before attempting any clear work).
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = "test-conv-" + key
	mgr.mu.Unlock()

	// Persist a stub conversation file so conversation.Load succeeds.
	conv := conversation.CreateConversation(s.conversationID, "system", "test-model")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Register an in-process extension whose session_start handler increments
	// a counter. We do NOT fire session_start as part of setup — counter
	// should stay 0 until SendCommand("clear") triggers the re-fire.
	var fired atomic.Int32
	host := extension.NewHost()
	host.SDK().On(extension.HookSessionStart, func(ctx *extension.Context, payload interface{}) (interface{}, error) {
		fired.Add(1)
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	mgr.TestSetExtGroup(key, group)

	if got := fired.Load(); got != 0 {
		t.Fatalf("session_start fired before /clear: got %d, want 0", got)
	}

	// Dispatch /clear via the manager's command entrypoint.
	mgr.SendCommand(key, "clear", "")

	if got := fired.Load(); got != 1 {
		t.Fatalf("session_start did not re-fire on /clear: got %d, want 1", got)
	}
}

// TestSendCommand_Clear_WipesConversationMessages verifies the existing
// (pre-PR) behaviour of /clear is preserved: it wipes Messages on the
// on-disk conversation file. This was previously untested. We're adding
// it now as a regression net for the load-bearing wipe behaviour.
func TestSendCommand_Clear_WipesConversationMessages(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-wipes-messages"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	// Seed a conversation with at least one persisted message so we can
	// observe the wipe.
	convID := "wipe-test-conv-" + key
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	conv.Messages = []types.LlmMessage{
		{Role: "user", Content: "hello"},
		{Role: "assistant", Content: "world"},
	}
	conv.LastInputTokens = 42
	conv.LastInputTokensMsgCount = 2
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}

	// Confirm setup wrote what we expect.
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	loaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("verify-seed Load: %v", err)
	}
	if len(loaded.Messages) != 2 {
		t.Fatalf("verify-seed: expected 2 messages on disk before clear, got %d", len(loaded.Messages))
	}

	// Dispatch /clear.
	mgr.SendCommand(key, "clear", "")

	// Reload from disk and assert Messages was wiped.
	cleared, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if len(cleared.Messages) != 0 {
		t.Errorf("expected Messages wiped after /clear, got %d messages: %+v", len(cleared.Messages), cleared.Messages)
	}
	if cleared.LastInputTokens != 0 {
		t.Errorf("expected LastInputTokens reset to 0, got %d", cleared.LastInputTokens)
	}
	if cleared.LastInputTokensMsgCount != 0 {
		t.Errorf("expected LastInputTokensMsgCount reset to 0, got %d", cleared.LastInputTokensMsgCount)
	}
}

// TestSendCommand_Clear_NoExtensionsIsOk verifies that /clear on a session
// without any extensions does not panic or error — it should just wipe
// messages and skip the session_start re-fire (because there's nothing to
// fire it on). Normal (non-engine) conversation tabs hit this branch.
func TestSendCommand_Clear_NoExtensionsIsOk(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "clear-no-extensions"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	convID := "no-ext-conv-" + key
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "", "test-model")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}

	// Should not panic. extGroup is nil at this point (no extensions loaded).
	mgr.SendCommand(key, "clear", "")
}
