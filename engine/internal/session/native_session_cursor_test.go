package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// cursor_test.go pins the terminal-failure half of native-session continuity:
// a delegated-CLI run that reports a terminal ErrorEvent (e.g. its
// autocompactor thrashing until the process exits non-zero) must not leave a
// resumable cursor behind. Resuming that cursor puts the very next prompt
// straight back into the same saturated native session; with the cursor gone,
// resolveCliContinuity bridges from Ion's transcript instead.

// seedCliSession stands up a session shaped like a mid-flight delegated-CLI
// run: CLI capabilities recorded at dispatch, a pending user turn (the
// CLI-served discriminator), a bound run, and an existing conversation file
// carrying a persisted cursor for the CLI kind.
func seedCliSession(t *testing.T, mgr *Manager, key, convID, runID, cursor string) *engineSession {
	t.Helper()
	_, _ = mgr.StartSession(key, defaultConfig())

	conv := conversation.CreateConversation(convID, "", "claude-sonnet-4-6")
	conversation.AddUserMessage(conv, "earlier turn")
	conv.NativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: cursor, HeadEntryID: conversation.CurrentLeafID(conv)},
	}
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("Save: %v", err)
	}

	caps := backend.NewClaudeCodeBackend().Capabilities()
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	s.runCaps = caps
	s.pendingCliUserTurn = "the failing prompt"
	s.nativeSessions = map[string]conversation.NativeSessionCursor{
		"claude-code": {Cursor: cursor, HeadEntryID: ""},
	}
	mgr.mu.Unlock()
	mgr.mu.Lock()
	mgr.bindRunLocked(runID, key)
	mgr.mu.Unlock()
	return s
}

func cursorFor(t *testing.T, convID, kind string) (conversation.NativeSessionCursor, bool) {
	t.Helper()
	conv, err := conversation.Load(convID, "")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	c, ok := conv.NativeSessions[kind]
	return c, ok
}

// TestCursorInvalidation_TerminalCliErrorDeletesCursor is the regression test
// for the thrash-resume loop: ErrorEvent on a CLI-served run + non-zero exit
// must delete the cursor from both the in-memory map and the persisted
// .tree.jsonl header, and must not capture the newly-reported native id.
func TestCursorInvalidation_TerminalCliErrorDeletesCursor(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID, runID = "cursor-invalidate", "1784000000000-eeeeeeeeeeee", "cursor-invalidate-run-1"
	s := seedCliSession(t, mgr, key, convID, runID, "saturated-native-uuid")

	// The CLI's terminal result error (the "Autocompact is thrashing" shape)
	// arrives as a typed ErrorEvent on the run, then the process exits 1
	// reporting its native session id.
	mgr.handleNormalizedEvent(runID, types.NormalizedEvent{Data: &types.ErrorEvent{
		ErrorMessage: "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row.",
		IsError:      true,
	}})
	code := 1
	mgr.handleRunExit(runID, &code, nil, "saturated-native-uuid")

	mgr.mu.RLock()
	_, inMemory := s.nativeSessions["claude-code"]
	mgr.mu.RUnlock()
	if inMemory {
		t.Fatal("in-memory cursor survived a terminal CLI failure; next prompt would --resume the saturated session")
	}
	if c, ok := cursorFor(t, convID, "claude-code"); ok {
		t.Fatalf("persisted cursor survived a terminal CLI failure: %+v", c)
	}
}

// TestCursorCapture_CleanCliExitStillCaptures pins the inverse: a clean exit
// with a reported native id captures the cursor exactly as before — the
// invalidation branch must not fire without the terminal-error flag.
func TestCursorCapture_CleanCliExitStillCaptures(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(backend.NewClaudeCodeBackend())
	const key, convID, runID = "cursor-capture", "1784000000000-ffffffffffff", "cursor-capture-run-1"
	s := seedCliSession(t, mgr, key, convID, runID, "old-native-uuid")

	mgr.mu.Lock()
	s.pendingCliAssistantText = "clean answer"
	mgr.mu.Unlock()
	code := 0
	mgr.handleRunExit(runID, &code, nil, "fresh-native-uuid")

	mgr.mu.RLock()
	got, inMemory := s.nativeSessions["claude-code"]
	mgr.mu.RUnlock()
	if !inMemory || got.Cursor != "fresh-native-uuid" {
		t.Fatalf("clean exit did not capture the fresh cursor: %+v (present=%v)", got, inMemory)
	}
	if c, ok := cursorFor(t, convID, "claude-code"); !ok || c.Cursor != "fresh-native-uuid" {
		t.Fatalf("persisted cursor not updated on clean exit: %+v (present=%v)", c, ok)
	}
}

// TestCursorInvalidation_FlagClearedOnNextDispatch verifies the terminal flag
// is per-run state: prompt dispatch resets it alongside the pending CLI turn,
// so a failed run cannot poison the NEXT run's exit handling.
func TestCursorInvalidation_FlagClearedOnNextDispatch(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("flag-clear", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["flag-clear"]
	s.cliRunFailedTerminal = true
	mgr.mu.Unlock()

	if err := mgr.SendPrompt("flag-clear", "next prompt", nil); err != nil {
		t.Fatalf("SendPrompt: %v", err)
	}

	mgr.mu.RLock()
	flag := s.cliRunFailedTerminal
	mgr.mu.RUnlock()
	if flag {
		t.Fatal("cliRunFailedTerminal not cleared at dispatch; a prior failure would invalidate the next run's cursor")
	}
}

// TestErrorEvent_DoesNotFlagEngineOwnedRuns pins the discriminator: an
// ErrorEvent on an engine-owned (API) run — where pendingCliUserTurn is empty —
// must not set the terminal-CLI flag. Engine-owned runs have no native cursor
// to protect, and flagging them would leak WARN noise into every provider
// error.
func TestErrorEvent_DoesNotFlagEngineOwnedRuns(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("api-error", defaultConfig())
	mgr.mu.Lock()
	mgr.bindRunLocked("api-error-run-1", "api-error")
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("api-error-run-1", types.NormalizedEvent{Data: &types.ErrorEvent{
		ErrorMessage: "rate_limit", IsError: true,
	}})

	mgr.mu.RLock()
	flag := mgr.sessions["api-error"].cliRunFailedTerminal
	mgr.mu.RUnlock()
	if flag {
		t.Fatal("engine-owned run was flagged as a terminal CLI failure")
	}
}
