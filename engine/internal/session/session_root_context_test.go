package session

import (
	"context"
	"testing"
	"time"
)

// session_root_context_test.go — tests for the per-session cancellation
// root introduced for the unified abort tree (#232). These pin the new
// behavior: SendAbort and StopSession cancel the session root, and a
// context derived from RunOptions.ParentCtx (the root) observes Done().

// TestSendAbort_CancelsSessionRoot asserts that a user abort cancels the
// session's cancellation root, so any operation that derived its context
// from the root observes ctx.Done(). This is the structural guarantee that
// makes "hit Stop, kill everything" work: backend runs, dispatched agents,
// and in-flight llmCall all derive from this root.
func TestSendAbort_CancelsSessionRoot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("abort-root", defaultConfig())

	// Capture the session root and derive a child context the way a
	// backend run / llmCall / dispatch would.
	mgr.mu.RLock()
	s := mgr.sessions["abort-root"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("session not found after StartSession")
	}
	derived, cancel := context.WithCancel(s.rootContext())
	defer cancel()

	select {
	case <-derived.Done():
		t.Fatal("derived context cancelled before abort")
	default:
	}

	mgr.SendAbort("abort-root")

	select {
	case <-derived.Done():
		// expected: root cancellation cascaded to the derived context
	case <-time.After(2 * time.Second):
		t.Fatal("derived context not cancelled within 2s of SendAbort")
	}
}

// TestStopSession_CancelsSessionRoot asserts session teardown cancels the
// root the same way abort does, so descendants are torn down with the
// session.
func TestStopSession_CancelsSessionRoot(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("stop-root", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["stop-root"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("session not found after StartSession")
	}
	derived, cancel := context.WithCancel(s.rootContext())
	defer cancel()

	if err := mgr.StopSession("stop-root"); err != nil {
		t.Fatalf("StopSession: %v", err)
	}

	select {
	case <-derived.Done():
		// expected
	case <-time.After(2 * time.Second):
		t.Fatal("derived context not cancelled within 2s of StopSession")
	}
}

// TestSendPrompt_ThreadsParentCtx asserts the main-session dispatch threads
// the session root onto RunOptions.ParentCtx, so the backend run derives
// from it. Without this wiring the run would be orphaned on Background and a
// session abort could not cascade to it.
func TestSendPrompt_ThreadsParentCtx(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("parentctx", defaultConfig())
	_ = mgr.SendPrompt("parentctx", "go", nil)

	keys := mb.startedKeys()
	if len(keys) == 0 {
		t.Fatal("expected a run to start")
	}
	opts, ok := mb.getStarted(keys[0])
	if !ok {
		t.Fatal("started run options not captured")
	}
	if opts.ParentCtx == nil {
		t.Fatal("expected RunOptions.ParentCtx to be set to the session root; got nil (run would be orphaned on Background)")
	}

	// The threaded context must be the session's live root: cancelling the
	// session (abort) must cancel a context derived from opts.ParentCtx.
	derived, cancel := context.WithCancel(opts.ParentCtx)
	defer cancel()
	mgr.SendAbort("parentctx")
	select {
	case <-derived.Done():
		// expected: the threaded ParentCtx is the real session root
	case <-time.After(2 * time.Second):
		t.Fatal("ParentCtx did not cancel on SendAbort; threaded context is not the session root")
	}
}
