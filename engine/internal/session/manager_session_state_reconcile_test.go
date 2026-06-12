package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// currentSessionStatus / sessionState / IsRunning — backend cross-check tests
// ---------------------------------------------------------------------------
//
// These tests pin the Phase 1 self-reconciliation contract: a session
// whose in-memory requestID lingers after a non-graceful run
// termination must not report "running" indefinitely. The single
// computation site (currentSessionStatus) cross-checks against
// backend.IsRunning and clears the field when the backend disclaims
// ownership of the run.
//
// The user-visible failure these tests prevent is the "Ion Operations"
// scenario: the desktop reinstalls, ReconcileState fires, the engine
// emits engine_status state=running for a key whose backend run died
// hours earlier, and iOS pulses the parent tab forever.

// TestCurrentSessionStatus_ReportsIdleWhenRequestIDEmpty verifies the
// happy path: a session that has never dispatched a prompt (or whose
// run completed via handleRunExit and cleared requestID) reports idle.
func TestCurrentSessionStatus_ReportsIdleWhenRequestIDEmpty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("idle-session", defaultConfig())

	mgr.mu.RLock()
	s := mgr.sessions["idle-session"]
	mgr.mu.RUnlock()
	if s == nil {
		t.Fatal("expected session to exist")
	}

	mgr.mu.RLock()
	got := mgr.currentSessionStatus(s)
	mgr.mu.RUnlock()
	if got != "idle" {
		t.Errorf("expected state=idle for fresh session, got %q", got)
	}
}

// TestCurrentSessionStatus_ReportsRunningWhenBackendOwnsRun verifies
// the happy-path running case: requestID is set AND the backend agrees
// the run is still live, so state=running is the right answer.
func TestCurrentSessionStatus_ReportsRunningWhenBackendOwnsRun(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("running-session", defaultConfig())

	// Simulate a live dispatch: mark requestID on the session AND
	// register the run with the backend so the cross-check passes.
	mgr.mu.Lock()
	s := mgr.sessions["running-session"]
	s.requestID = "run-live-1"
	mgr.mu.Unlock()
	mb.StartRun("run-live-1", types.RunOptions{})

	mgr.mu.RLock()
	got := mgr.currentSessionStatus(s)
	stillSet := s.requestID
	mgr.mu.RUnlock()
	if got != "running" {
		t.Errorf("expected state=running when backend owns run, got %q", got)
	}
	if stillSet != "run-live-1" {
		t.Errorf("expected requestID to remain set when backend owns run, got %q", stillSet)
	}
}

// TestCurrentSessionStatus_ClearsStaleRequestIDAndReportsIdle is the
// regression test for the Ion Operations bug. requestID is set but the
// backend does not have a live run for it (simulating a run that
// terminated abnormally without flowing through handleRunExit /
// StopSession). The cross-check must clear the field and report idle.
func TestCurrentSessionStatus_ClearsStaleRequestIDAndReportsIdle(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("stale-session", defaultConfig())

	// Strand a requestID without telling the backend — exactly the
	// shape the production bug produced (orchestrator turn died, the
	// backend's activeRun was cleaned up, but s.requestID was never
	// reassigned to "").
	mgr.mu.Lock()
	s := mgr.sessions["stale-session"]
	s.requestID = "run-stale-orchestrator"
	mgr.mu.Unlock()

	// Verify the backend disclaims it before the cross-check runs.
	if mb.IsRunning("run-stale-orchestrator") {
		t.Fatal("test setup error: backend should not own a run we never started")
	}

	mgr.mu.Lock()
	got := mgr.currentSessionStatus(s)
	clearedTo := s.requestID
	mgr.mu.Unlock()
	if got != "idle" {
		t.Errorf("expected state=idle after stale-requestID clear, got %q", got)
	}
	if clearedTo != "" {
		t.Errorf("expected requestID cleared to '' after defensive clear, got %q", clearedTo)
	}
}

// TestSessionState_DelegatesToCurrentSessionStatus verifies the
// backwards-compat shim: the original sessionState symbol still exists
// and still returns the same string values, but it now flows through
// the cross-check. A stale requestID surfaces as idle through this
// path too — important because ReconcileState reads the value via
// sessionState today.
func TestSessionState_DelegatesToCurrentSessionStatus(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("delegate-session", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["delegate-session"]
	s.requestID = "run-orphan"
	mgr.mu.Unlock()

	// Stale: backend does not know about run-orphan.
	mgr.mu.Lock()
	got := mgr.sessionState(s)
	cleared := s.requestID
	mgr.mu.Unlock()
	if got != "idle" {
		t.Errorf("expected sessionState=idle through delegation, got %q", got)
	}
	if cleared != "" {
		t.Errorf("expected sessionState path to clear stale requestID, got %q", cleared)
	}
}

// TestIsRunning_UsesBackendCrossCheck verifies the public IsRunning
// API uses the same cross-check as the internal status function. A
// caller that polls IsRunning to gate "can I dispatch a new prompt?"
// would otherwise refuse forever when a stranded requestID is on the
// session.
func TestIsRunning_UsesBackendCrossCheck(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("isrunning-session", defaultConfig())

	// Strand a requestID and confirm IsRunning reports false (because
	// the backend disclaims the run) AND that the stranded field is
	// cleared as a side effect, freeing up the session for the next
	// SendPrompt.
	mgr.mu.Lock()
	mgr.sessions["isrunning-session"].requestID = "run-zombie"
	mgr.mu.Unlock()

	if mgr.IsRunning("isrunning-session") {
		t.Error("expected IsRunning=false when backend disclaims requestID")
	}

	mgr.mu.RLock()
	stillSet := mgr.sessions["isrunning-session"].requestID
	mgr.mu.RUnlock()
	if stillSet != "" {
		t.Errorf("expected IsRunning to clear stranded requestID, got %q", stillSet)
	}
}

// TestReconcileState_EmitsIdleAfterStaleRequestIDClear is the
// end-to-end Phase 1 regression test. It drives the full ReconcileState
// path — the one the desktop calls on attach — and asserts the engine
// emits state=idle when the cross-check kicks in, not state=running.
// This is the precise check that would have caught the Ion Operations
// failure at PR review time.
func TestReconcileState_EmitsIdleAfterStaleRequestIDClear(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("reconcile-stale", defaultConfig())

	mgr.mu.Lock()
	mgr.sessions["reconcile-stale"].requestID = "run-orphan-orchestrator"
	mgr.mu.Unlock()

	var statusEvents []types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_status" {
			statusEvents = append(statusEvents, ev)
		}
	})

	mgr.ReconcileState("reconcile-stale")

	if len(statusEvents) == 0 {
		t.Fatal("expected engine_status from ReconcileState")
	}
	last := statusEvents[len(statusEvents)-1]
	if last.Fields == nil {
		t.Fatal("expected non-nil StatusFields")
	}
	if last.Fields.State != "idle" {
		t.Errorf("expected reconciled state=idle after stale-requestID clear, got %q", last.Fields.State)
	}

	// Verify the side-effect clear happened so a follow-up SendPrompt
	// is not blocked by the stranded field.
	mgr.mu.RLock()
	cleared := mgr.sessions["reconcile-stale"].requestID
	mgr.mu.RUnlock()
	if cleared != "" {
		t.Errorf("expected ReconcileState to clear stranded requestID via cross-check, got %q", cleared)
	}
}
