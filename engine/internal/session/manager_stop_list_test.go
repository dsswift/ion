package session

import (
	"strings"
	"testing"
)

func TestStopSession_CleansUp(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("stop-me", defaultConfig())

	err := mgr.StopSession("stop-me")
	if err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	sessions := mgr.ListSessions()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after stop, got %d", len(sessions))
	}
}

func TestStopSession_UnknownSessionError(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.StopSession("ghost")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if !strings.Contains(err.Error(), "not found") {
		t.Errorf("expected 'not found' in error, got %q", err.Error())
	}
}

func TestStopSession_CancelsActiveRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("active", defaultConfig())
	_ = mgr.SendPrompt("active", "working", nil)

	if !mgr.IsRunning("active") {
		t.Fatal("session should be running")
	}

	_ = mgr.StopSession("active")

	// Backend should have received a Cancel call
	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount == 0 {
		t.Error("expected Cancel to be called on the backend")
	}
}

func TestStopSession_EmitsDeadEvent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	ec := newEventCollector(mgr)

	_, _ = mgr.StartSession("die", defaultConfig())
	_ = mgr.StopSession("die")

	deadEvents := ec.byType("engine_dead")
	if len(deadEvents) == 0 {
		t.Error("expected engine_dead event after stop")
	}
}

func TestStopSession_Idempotent(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("once", defaultConfig())

	if err := mgr.StopSession("once"); err != nil {
		t.Fatalf("first stop: %v", err)
	}
	err := mgr.StopSession("once")
	if err == nil {
		t.Fatal("second stop should return error (session gone)")
	}
}

// ---------------------------------------------------------------------------
// StopAll tests
// ---------------------------------------------------------------------------

func TestStopAll_MultipleSessions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for _, key := range []string{"a", "b", "c", "d"} {
		_, _ = mgr.StartSession(key, defaultConfig())
	}

	if len(mgr.ListSessions()) != 4 {
		t.Fatal("expected 4 sessions")
	}

	err := mgr.StopAll()
	if err != nil {
		t.Fatalf("StopAll: %v", err)
	}

	if len(mgr.ListSessions()) != 0 {
		t.Error("expected 0 sessions after StopAll")
	}
}

func TestStopAll_EmptyManager(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	err := mgr.StopAll()
	if err != nil {
		t.Fatalf("StopAll on empty manager: %v", err)
	}
}

func TestStopAll_CancelsActiveRuns(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("r1", defaultConfig())
	_, _ = mgr.StartSession("r2", defaultConfig())
	_ = mgr.SendPrompt("r1", "work1", nil)
	_ = mgr.SendPrompt("r2", "work2", nil)

	_ = mgr.StopAll()

	mb.mu.Lock()
	cancelCount := len(mb.cancelled)
	mb.mu.Unlock()
	if cancelCount < 2 {
		t.Errorf("expected at least 2 cancels, got %d", cancelCount)
	}
}

// ---------------------------------------------------------------------------
// StopByPrefix tests
// ---------------------------------------------------------------------------

func TestStopByPrefix_PrefixMatching(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	for _, key := range []string{"app-1", "app-2", "app-3", "other-1", "other-2"} {
		_, _ = mgr.StartSession(key, defaultConfig())
	}

	mgr.StopByPrefix("app-")

	sessions := mgr.ListSessions()
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions remaining, got %d", len(sessions))
	}
	for _, s := range sessions {
		if strings.HasPrefix(s.Key, "app-") {
			t.Errorf("session %q should have been stopped", s.Key)
		}
	}
}

func TestStopByPrefix_NoMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("foo", defaultConfig())
	_, _ = mgr.StartSession("bar", defaultConfig())

	mgr.StopByPrefix("xyz-")

	if len(mgr.ListSessions()) != 2 {
		t.Error("no sessions should have been stopped")
	}
}

func TestStopByPrefix_ExactPrefixMatch(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("abc", defaultConfig())
	_, _ = mgr.StartSession("abcdef", defaultConfig())
	_, _ = mgr.StartSession("ab", defaultConfig())

	mgr.StopByPrefix("abc")

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session remaining, got %d", len(sessions))
	}
	if sessions[0].Key != "ab" {
		t.Errorf("expected 'ab' to remain, got %q", sessions[0].Key)
	}
}

// ---------------------------------------------------------------------------
// ListSessions tests
// ---------------------------------------------------------------------------

func TestListSessions_Empty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	sessions := mgr.ListSessions()
	if sessions == nil {
		t.Fatal("expected non-nil slice")
	}
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions, got %d", len(sessions))
	}
}

func TestListSessions_Populated(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("x", defaultConfig())
	_, _ = mgr.StartSession("y", defaultConfig())
	_, _ = mgr.StartSession("z", defaultConfig())

	sessions := mgr.ListSessions()
	if len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got %d", len(sessions))
	}

	keys := make(map[string]bool)
	for _, s := range sessions {
		keys[s.Key] = true
	}
	for _, k := range []string{"x", "y", "z"} {
		if !keys[k] {
			t.Errorf("missing session key %q", k)
		}
	}
}

func TestListSessions_HasActiveRunFlag(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("idle-sess", defaultConfig())
	_, _ = mgr.StartSession("busy-sess", defaultConfig())
	_ = mgr.SendPrompt("busy-sess", "working", nil)

	sessions := mgr.ListSessions()
	for _, s := range sessions {
		switch s.Key {
		case "idle-sess":
			if s.HasActiveRun {
				t.Error("idle-sess should not have active run")
			}
		case "busy-sess":
			if !s.HasActiveRun {
				t.Error("busy-sess should have active run")
			}
		}
	}
}

func TestListSessions_AfterStopShowsReduced(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	_, _ = mgr.StartSession("keep", defaultConfig())
	_, _ = mgr.StartSession("remove", defaultConfig())
	_ = mgr.StopSession("remove")

	sessions := mgr.ListSessions()
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].Key != "keep" {
		t.Errorf("expected key=keep, got %q", sessions[0].Key)
	}
}
