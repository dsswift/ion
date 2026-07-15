package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// TestSendPrompt_RootCtxCarriesConversationID pins that the root context
// threaded onto RunOptions.ParentCtx carries BOTH session_id and
// conversation_id. This is the pre-condition for the ambient logging
// correlation: SetAmbientCtx(ctx) in runLoop stamps both IDs on every
// utils.Log call. Revert conversation_id threading from newSessionRootContext
// and this test goes red.
func TestSendPrompt_RootCtxCarriesConversationID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("corrtest", defaultConfig())

	// Capture the session's conversation ID (set at StartSession).
	mgr.mu.RLock()
	s := mgr.sessions["corrtest"]
	expectedConvID := s.conversationID
	mgr.mu.RUnlock()
	if expectedConvID == "" {
		t.Fatal("session conversationID is empty after StartSession")
	}

	_ = mgr.SendPrompt("corrtest", "hello", nil)
	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("no run started")
	}
	opts, ok := mb.getStarted(keys[0])
	if !ok {
		t.Fatal("run options not captured")
	}
	if opts.ParentCtx == nil {
		t.Fatal("ParentCtx is nil")
	}

	gotSessionID := utils.SessionIDFromContext(opts.ParentCtx)
	gotConvID := utils.ConversationIDFromContext(opts.ParentCtx)

	if gotSessionID != "corrtest" {
		t.Errorf("session_id in ParentCtx = %q, want %q", gotSessionID, "corrtest")
	}
	if gotConvID != expectedConvID {
		t.Errorf("conversation_id in ParentCtx = %q, want %q", gotConvID, expectedConvID)
	}
}
