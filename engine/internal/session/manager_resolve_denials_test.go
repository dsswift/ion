package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// resolve_permission_denials — the third release path for retained denials.
//
// The engine retains an unresolved AskUserQuestion / ExitPlanMode so every
// status snapshot tells a re-attaching consumer that a question is still
// outstanding. Retention was released on exactly two paths: a new prompt
// supersedes the question (prompt_dispatch.go) or /clear discards it
// (clear_core.go). Neither covers a resolution that produces no prompt and no
// clear — a user dismissing the card is the common case.
//
// Without a way to say "resolved", the engine re-published the denial on every
// heartbeat and each consumer had to suppress the echo locally and
// permanently. That local suppression is load-bearing state with no recovery:
// when anything drops the consumer's copy of the card, the re-publication it
// needs to heal is exactly what its own suppression discards. That is what
// stranded a live conversation with a plan and no way to act on it.
//
// Revert contract: removing the ResolvePermissionDenials manager method, its
// dispatch arm, or its validCommands entry makes these tests go red.

// seedRetainedDenial puts the session into the state the engine is in after a
// task_complete that carried an unresolved plan proposal.
func seedRetainedDenial(t *testing.T, mgr *Manager, key string) *engineSession {
	t.Helper()
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	s := mgr.sessions[key]
	if s == nil {
		t.Fatalf("session %q not found", key)
	}
	s.lastPermissionDenials = []types.PermissionDenial{
		{ToolName: "ExitPlanMode", ToolUseID: "toolu_exit_1"},
	}
	return s
}

func TestResolvePermissionDenials_ClearsRetainedDenial(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mgr := NewManager(newMockBackend())
	const key = "resolve-denials-clears"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	s := seedRetainedDenial(t, mgr, key)

	var mu sync.Mutex
	var statusEvents []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_status" {
			mu.Lock()
			statusEvents = append(statusEvents, ev)
			mu.Unlock()
		}
	})

	mgr.ResolvePermissionDenials(key)

	// Half 1: the retention is released on the session, so no later heartbeat
	// can re-publish the question.
	mgr.mu.Lock()
	got := s.lastPermissionDenials
	mgr.mu.Unlock()
	if len(got) != 0 {
		t.Errorf("expected retained denials cleared, got %d: %+v", len(got), got)
	}

	// Half 2: a snapshot is emitted so EVERY attached consumer converges, not
	// just the caller. A second client must not keep showing a card the first
	// one resolved.
	mu.Lock()
	defer mu.Unlock()
	if len(statusEvents) == 0 {
		t.Fatal("expected an engine_status snapshot after resolving denials, got none")
	}
	last := statusEvents[len(statusEvents)-1]
	if last.Fields == nil {
		t.Fatal("engine_status carried nil Fields")
	}
	if n := len(last.Fields.PermissionDenials); n != 0 {
		t.Errorf("snapshot still carries %d denials: %+v", n, last.Fields.PermissionDenials)
	}
}

// Resolving a card changes no messages, so occupancy must be untouched.
//
// The mechanism reuses the same retention drop /clear uses, but /clear also
// zeroes context because it empties the conversation. Sharing that whole
// helper would have made the engine report an empty context window for a
// conversation that still holds everything — every consumer's context meter
// would read zero until the next real usage event.
func TestResolvePermissionDenials_PreservesContextOccupancy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mgr := NewManager(newMockBackend())
	const key = "resolve-denials-keeps-context"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	s := seedRetainedDenial(t, mgr, key)
	mgr.mu.Lock()
	s.lastContextPct = 42
	s.lastContextTokens = 84_000
	mgr.mu.Unlock()

	mgr.ResolvePermissionDenials(key)

	mgr.mu.Lock()
	pct, tokens, denials := s.lastContextPct, s.lastContextTokens, len(s.lastPermissionDenials)
	mgr.mu.Unlock()

	if denials != 0 {
		t.Errorf("expected denials cleared, got %d", denials)
	}
	if pct != 42 {
		t.Errorf("context percent was reset to %d, want 42 preserved", pct)
	}
	if tokens != 84_000 {
		t.Errorf("context tokens were reset to %d, want 84000 preserved", tokens)
	}
}

// /clear keeps its own semantics: it DOES empty the conversation, so zeroing
// occupancy alongside the denial remains correct there. Pins the split so a
// future edit cannot collapse the two paths back together.
func TestClearSessionDenials_StillZeroesContextOccupancy(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mgr := NewManager(newMockBackend())
	const key = "clear-denials-zeroes-context"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	s := seedRetainedDenial(t, mgr, key)
	mgr.mu.Lock()
	s.lastContextPct = 42
	s.lastContextTokens = 84_000
	mgr.mu.Unlock()

	sessionKey, n := mgr.clearSessionDenials(key)

	if sessionKey != key {
		t.Errorf("got session key %q, want %q", sessionKey, key)
	}
	if n != 1 {
		t.Errorf("got %d denials cleared, want 1", n)
	}

	mgr.mu.Lock()
	pct, tokens := s.lastContextPct, s.lastContextTokens
	mgr.mu.Unlock()

	if pct != 0 || tokens != 0 {
		t.Errorf("/clear left occupancy at pct=%d tokens=%d, want both 0", pct, tokens)
	}
}

// A consumer may resolve a card for a conversation whose session already
// exited. There is nothing to release and it is not an error.
func TestResolvePermissionDenials_UnknownKeyIsQuiet(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mgr := NewManager(newMockBackend())

	var emitted int
	mgr.OnEvent(func(_ string, _ types.EngineEvent) { emitted++ })

	mgr.ResolvePermissionDenials("no-such-session")

	if emitted != 0 {
		t.Errorf("expected no events for an unknown key, got %d", emitted)
	}
}

// Resolving when nothing is retained is a no-op the consumer may safely
// repeat: a second click, or two clients resolving the same card.
func TestResolvePermissionDenials_Idempotent(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	mgr := NewManager(newMockBackend())
	const key = "resolve-denials-idempotent"
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession failed: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })

	seedRetainedDenial(t, mgr, key)

	mgr.ResolvePermissionDenials(key)
	mgr.ResolvePermissionDenials(key)

	mgr.mu.Lock()
	n := len(mgr.sessions[key].lastPermissionDenials)
	mgr.mu.Unlock()
	if n != 0 {
		t.Errorf("expected denials to stay cleared, got %d", n)
	}
}
