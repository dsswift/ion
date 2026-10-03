package session

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// slash_fork_test.go pins the `context: fork` execution path (forkResolvedSlash),
// which previously shipped with no behavioral test:
//
//   - the raw invocation is persisted as the PARENT's display turn (tree entry
//     with slash provenance) while the parent's LLM message history is left
//     untouched (the expansion runs in the child, not the parent);
//   - forkResolvedSlash returns PROMPTLY — it must not block the caller while the
//     forked child runs. This is the regression guard for the blocking-dispatch
//     defect: forkResolvedSlash is called synchronously on the per-connection
//     dispatch loop, so a foreground (blocking) DispatchAgent would stall the
//     connection for the entire child run. The fix dispatches with
//     Background: true, which returns a stub immediately.

// TestForkResolvedSlash_PersistsParentDisplayTurn pins that a fork-context slash
// command records the raw invocation (with provenance) as the parent's display
// turn, and does NOT append an LLM message to the parent (the expansion is the
// child's input, not the parent's).
func TestForkResolvedSlash_PersistsParentDisplayTurn(t *testing.T) {
	tempHome := t.TempDir()
	t.Setenv("HOME", tempHome)

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "fork-display-turn"
	convID := "fork-test-conv-" + key
	convDir := filepath.Join(tempHome, ".ion", "conversations")
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() {
		_ = mgr.StopSession(key)
		// Stopping cancels the forked child, which then writes its terminal
		// record into the parent conversation. Wait for that write so the
		// temp dir is not removed under it.
		waitForDispatchRecordsTerminal(t, convDir, convID)
	})

	// Seed a parent conversation on disk so forkResolvedSlash can load + append.
	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = convID
	mgr.mu.Unlock()

	conv := conversation.CreateConversation(convID, "system", "test-model")
	// Seed via AddUserMessage so the conversation has both an LLM message and a
	// tree entry (mirroring a real prior turn). This also ensures Entries is a
	// populated, non-nil slice after the Save/Load round-trip — the precondition
	// forkResolvedSlash checks before appending the display turn.
	conversation.AddUserMessage(conv, "earlier turn")
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed conversation save: %v", err)
	}
	messagesBefore := len(conv.Messages)

	opts := &types.RunOptions{
		Prompt:               "EXPANDED fork body for the child",
		ResolvedSlashCommand: "/heavy",
		ResolvedSlashArgs:    "the payload",
		ResolvedSlashSource:  slashSourceIon,
		ResolvedSlashContext: "fork",
	}

	// forkResolvedSlash must return promptly (non-blocking). Run it in a
	// goroutine guarded by a deadline; a foreground/blocking dispatch would
	// either hang here or take far longer than the bound.
	done := make(chan struct{})
	go func() {
		mgr.forkResolvedSlash(s, key, opts)
		close(done)
	}()
	select {
	case <-done:
		// returned promptly — good
	case <-time.After(3 * time.Second):
		t.Fatal("forkResolvedSlash did not return promptly — it is blocking on the child run (regression: dispatch must be Background)")
	}

	// The parent display turn was persisted with raw invocation + provenance.
	loaded, err := conversation.Load(convID, convDir)
	if err != nil {
		t.Fatalf("post-fork Load: %v", err)
	}

	// The parent's LLM message history is untouched (the child consumes the
	// expansion, the parent does not).
	if len(loaded.Messages) != messagesBefore {
		t.Errorf("parent LLM messages changed: before=%d after=%d (fork must not append an LLM turn to the parent)", messagesBefore, len(loaded.Messages))
	}

	// The display entry holds the raw invocation + provenance. After Load,
	// entry.Data is rehydrated to a conversation.MessageData value, whose
	// SlashCommand/SlashArgs/SlashSource are plain exported strings (robust
	// across the JSON round-trip — unlike the loosely-typed Content field).
	var found bool
	for _, e := range loaded.Entries {
		md, ok := e.Data.(conversation.MessageData)
		if !ok {
			continue
		}
		if md.SlashCommand == "/heavy" {
			found = true
			if md.SlashArgs != "the payload" || md.SlashSource != slashSourceIon {
				t.Errorf("display entry provenance = (%q,%q,%q)", md.SlashCommand, md.SlashArgs, md.SlashSource)
			}
		}
	}
	if !found {
		t.Fatalf("expected a display entry with SlashCommand=/heavy; entries=%+v", loaded.Entries)
	}
}

// TestForkResolvedSlash_NoConversationDoesNotPanic pins the best-effort
// persistence contract: when the session has no conversation id yet, the fork
// still dispatches (and returns promptly) without panicking on the absent
// conversation.
func TestForkResolvedSlash_NoConversationDoesNotPanic(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)

	const key = "fork-no-conv"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	mgr.mu.Lock()
	s := mgr.sessions[key]
	s.conversationID = "" // no conversation
	mgr.mu.Unlock()

	opts := &types.RunOptions{
		Prompt:               "expanded",
		ResolvedSlashCommand: "/heavy",
		ResolvedSlashContext: "fork",
	}

	done := make(chan struct{})
	go func() {
		mgr.forkResolvedSlash(s, key, opts)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("forkResolvedSlash did not return promptly with no conversation")
	}
}

// waitForDispatchRecordsTerminal waits until every agent_dispatch record in the
// conversation on disk carries its terminal outcome and the conversation's save
// lock is released.
func waitForDispatchRecordsTerminal(t *testing.T, convDir, convID string) {
	t.Helper()
	lockPath := filepath.Join(convDir, ".conversation-"+convID+".lock")
	waitFor(t, "dispatch terminal record persisted", func() bool {
		conv, err := conversation.Load(convID, convDir)
		if err != nil {
			return false
		}
		for _, e := range conv.Entries {
			if e.Type != conversation.EntryAgentDispatch {
				continue
			}
			if d := conversation.AsAgentDispatchData(e.Data); d == nil || d.Terminal == nil {
				return false
			}
		}
		_, statErr := os.Stat(lockPath)
		return os.IsNotExist(statErr)
	})
}
