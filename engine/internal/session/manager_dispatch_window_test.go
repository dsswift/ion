package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// Dispatch-in-flight window — currentSessionStatus guard tests
// ---------------------------------------------------------------------------
//
// These tests pin the fix for the done-group misplacement bug: SendPrompt
// assigns s.requestID hundreds of milliseconds BEFORE the backend Start*
// call registers the run in its live-run table (slash resolution, plan-file
// allocation, capability gates, extension/MCP wiring all run in between).
// In that window backend.IsRunning(requestID) answers false, so the
// stale-requestID cross-check in currentSessionStatus misread the
// about-to-start run as stale, destructively cleared s.requestID, and
// reported state=idle for the entire run. The engine never emitted running
// again — every heartbeat re-published idle — and consumers marked a live,
// streaming conversation as done.
//
// Production instance: conversation 1784586083858-6e7662256c6f. A
// reconcile_state raced SendPrompt; the WARN "currentsessionstatus:
// clearing stale requestid (backend disclaims run)" fired at
// 00:23:05.728, 57ms before StartRun registered the run at 00:23:05.785.
// The desktop synthesized task_complete off the next heartbeat idle and
// auto-moved the tab to the done group while the run streamed for another
// 8 minutes.
//
// The fix: engineSession.dispatchingRunID marks the window (set alongside
// the requestID assignment, cleared when SendPrompt returns). While the
// marker equals s.requestID, currentSessionStatus reports running WITHOUT
// consulting the backend and WITHOUT clearing.

// TestCurrentSessionStatus_DispatchWindowReportsRunning is the direct
// regression test: requestID is set, the backend disclaims the run (not
// yet registered), but the dispatch-in-flight marker covers it. The
// status must be "running" and the requestID must NOT be cleared.
//
// On the unfixed code this fails both assertions: status comes back
// "idle" and requestID is destructively cleared.
func TestCurrentSessionStatus_DispatchWindowReportsRunning(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("dispatch-window", defaultConfig())

	// Reproduce the exact window shape: requestID assigned, marker set,
	// backend NOT yet aware of the run (SendPrompt has not reached the
	// backend Start* call).
	mgr.mu.Lock()
	s := mgr.sessions["dispatch-window"]
	s.requestID = "run-dispatching-1"
	s.dispatchingRunID = "run-dispatching-1"
	mgr.mu.Unlock()

	if mb.IsRunning("run-dispatching-1") {
		t.Fatal("test setup error: backend must disclaim the not-yet-registered run")
	}

	mgr.mu.Lock()
	got := mgr.currentSessionStatus(s)
	remaining := s.requestID
	mgr.mu.Unlock()

	if got != "running" {
		t.Errorf("expected state=running during dispatch window, got %q", got)
	}
	if remaining != "run-dispatching-1" {
		t.Errorf("expected requestID preserved during dispatch window, got %q", remaining)
	}
}

// TestCurrentSessionStatus_StaleMarkerDoesNotMaskStaleRequestID verifies
// the guard is run-scoped: a dispatchingRunID left over from an EARLIER
// run must not protect a genuinely stale requestID from a LATER run. The
// stale-detection contract (the Ion Operations fix) survives intact.
func TestCurrentSessionStatus_StaleMarkerDoesNotMaskStaleRequestID(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("stale-marker", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["stale-marker"]
	s.requestID = "run-stale-2"
	s.dispatchingRunID = "run-old-1" // marker from a different, earlier dispatch
	mgr.mu.Unlock()

	mgr.mu.Lock()
	got := mgr.currentSessionStatus(s)
	cleared := s.requestID
	mgr.mu.Unlock()

	if got != "idle" {
		t.Errorf("expected state=idle for stale requestID with mismatched marker, got %q", got)
	}
	if cleared != "" {
		t.Errorf("expected stale requestID cleared, got %q", cleared)
	}
}

// TestSendPrompt_ClearsDispatchMarkerOnReturn verifies the normal path:
// after SendPrompt returns (backend Start* has registered the run), the
// marker is cleared so the stale-detection cross-check governs again for
// the started run.
func TestSendPrompt_ClearsDispatchMarkerOnReturn(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("marker-cleared", defaultConfig())

	if err := mgr.SendPrompt("marker-cleared", "hello", nil); err != nil {
		t.Fatalf("SendPrompt failed: %v", err)
	}

	mgr.mu.RLock()
	s := mgr.sessions["marker-cleared"]
	marker := s.dispatchingRunID
	reqID := s.requestID
	mgr.mu.RUnlock()

	if marker != "" {
		t.Errorf("expected dispatchingRunID cleared after SendPrompt returned, got %q", marker)
	}
	if reqID == "" {
		t.Fatal("expected requestID set after successful dispatch")
	}
	// The backend registered the run inside StartRun, so the cross-check
	// must report running without needing the marker.
	mgr.mu.Lock()
	got := mgr.currentSessionStatus(s)
	mgr.mu.Unlock()
	if got != "running" {
		t.Errorf("expected state=running for registered run after dispatch, got %q", got)
	}
}

// TestSendPrompt_ClearsDispatchMarkerOnEarlyAbort verifies the early-abort
// path: an unresolvable slash invocation aborts the dispatch before any
// run starts. Both requestID and the dispatch marker must be cleared so
// the session reports idle and stays usable.
func TestSendPrompt_ClearsDispatchMarkerOnEarlyAbort(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("marker-abort", defaultConfig())

	// A slash invocation that resolves nowhere aborts the prompt with an
	// unknown_command result and no run.
	err := mgr.SendPrompt("marker-abort", "/definitely-not-a-real-command-xyz", &PromptOverrides{ResolveSlash: true})
	if err != nil {
		t.Fatalf("SendPrompt returned unexpected error: %v", err)
	}

	mgr.mu.RLock()
	s := mgr.sessions["marker-abort"]
	marker := s.dispatchingRunID
	reqID := s.requestID
	mgr.mu.RUnlock()

	if reqID != "" {
		t.Errorf("expected requestID cleared on early abort, got %q", reqID)
	}
	if marker != "" {
		t.Errorf("expected dispatchingRunID cleared on early abort, got %q", marker)
	}

	mgr.mu.Lock()
	got := mgr.currentSessionStatus(s)
	mgr.mu.Unlock()
	if got != "idle" {
		t.Errorf("expected state=idle after aborted dispatch, got %q", got)
	}
}

// TestEmitStatusSnapshot_DispatchWindowEmitsRunning pins the wire-level
// consequence: a status snapshot computed during the dispatch window
// (heartbeat / reconcile / query all share emitStatusSnapshot) must carry
// state=running, not state=idle. This is the exact emission that, on the
// unfixed code, told the desktop a live run was idle and triggered the
// done-group move.
func TestEmitStatusSnapshot_DispatchWindowEmitsRunning(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	var events []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		events = append(events, ev)
	})

	_, _ = mgr.StartSession("snapshot-window", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["snapshot-window"]
	s.requestID = "run-snap-1"
	s.dispatchingRunID = "run-snap-1"
	mgr.mu.Unlock()

	events = nil // discard StartSession emissions
	mgr.emitStatusSnapshot("snapshot-window", "test")

	var status *types.EngineEvent
	for i := range events {
		if events[i].Type == "engine_status" {
			status = &events[i]
			break
		}
	}
	if status == nil {
		t.Fatal("expected an engine_status emission from emitStatusSnapshot")
	}
	if status.Fields == nil || status.Fields.State != "running" {
		state := "<nil fields>"
		if status.Fields != nil {
			state = status.Fields.State
		}
		t.Errorf("expected engine_status state=running during dispatch window, got %q", state)
	}

	mgr.mu.RLock()
	preserved := s.requestID
	mgr.mu.RUnlock()
	if preserved != "run-snap-1" {
		t.Errorf("expected requestID to survive the snapshot, got %q", preserved)
	}
}
