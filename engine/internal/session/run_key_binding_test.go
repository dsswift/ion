package session

import (
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Routing-binding regression tests (Bug #1).
//
// The defect: keyForRun resolved a runID to its session key by scanning
// engineSession.requestID. currentSessionStatus transiently clears requestID
// mid-run when the backend momentarily disclaims a still-live run. When that
// clear raced an in-flight emit, keyForRun returned "" and handleNormalizedEvent
// silently dropped the event — observed as a dropped PlanModeChangedEvent that
// left the desktop's permission-mode pill stuck on "auto".
//
// The fix: a stable runID -> key binding, set at dispatch and consulted by
// keyForRun BEFORE the requestID scan, so routing survives the requestID clear.

// TestKeyForRun_SurvivesRequestIDClear is the core regression. With the binding
// in place, keyForRun must resolve a live run's key even after requestID has
// been cleared (as currentSessionStatus does). Reverting keyForRun to the
// requestID-only scan makes this go red.
func TestKeyForRun_SurvivesRequestIDClear(t *testing.T) {
	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("route-key", defaultConfig())

	const runID = "route-key-1782570666921"

	// Simulate dispatch: bind the run, set requestID (as prompt_dispatch does).
	mgr.mu.Lock()
	mgr.bindRunLocked(runID, "route-key")
	mgr.sessions["route-key"].requestID = runID
	mgr.mu.Unlock()

	// Sanity: resolves while requestID is set.
	if got := mgr.keyForRun(runID); got != "route-key" {
		t.Fatalf("keyForRun before clear: got %q, want route-key", got)
	}

	// Simulate currentSessionStatus clearing the transient requestID mid-run
	// (backend momentarily disclaims the run). The binding is NOT cleared —
	// the run is still live.
	mgr.mu.Lock()
	mgr.sessions["route-key"].requestID = ""
	mgr.mu.Unlock()

	// The binding must still resolve the key. RED on the old requestID-only
	// scan: the cleared field would make this return "".
	if got := mgr.keyForRun(runID); got != "route-key" {
		t.Fatalf("keyForRun after requestID clear: got %q, want route-key (event would be DROPPED)", got)
	}
}

// TestHandleNormalizedEvent_PlanModeChangedNotDroppedAfterRequestIDClear pins
// the end-to-end behavior: a PlanModeChangedEvent{Enabled:true} emitted while
// requestID is cleared must still be ROUTED (reach the onEvent callback) rather
// than silently dropped. This is the exact production scenario.
func TestHandleNormalizedEvent_PlanModeChangedNotDroppedAfterRequestIDClear(t *testing.T) {
	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("route-plan", defaultConfig())

	var mu sync.Mutex
	var routedTypes []string
	mgr.OnEvent(func(_ string, ee types.EngineEvent) {
		mu.Lock()
		routedTypes = append(routedTypes, ee.Type)
		mu.Unlock()
	})

	const runID = "route-plan-1782570666921"

	// Dispatch: bind + set requestID, then clear requestID (the race window).
	mgr.mu.Lock()
	mgr.bindRunLocked(runID, "route-plan")
	mgr.sessions["route-plan"].requestID = runID
	mgr.sessions["route-plan"].requestID = "" // currentSessionStatus clear
	mgr.mu.Unlock()

	// Route the entry event through the real handler.
	mgr.handleNormalizedEvent(runID, types.NormalizedEvent{
		Data: &types.PlanModeChangedEvent{
			Enabled:      true,
			PlanFilePath: "/home/ada/.ion/plans/minty-dancing-apple.md",
		},
	})

	mu.Lock()
	defer mu.Unlock()
	found := false
	for _, ty := range routedTypes {
		if ty == "engine_plan_mode_changed" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("PlanModeChangedEvent was DROPPED (routedTypes=%v) — expected engine_plan_mode_changed to be routed despite the requestID clear", routedTypes)
	}
}

// TestUnbindRun_ClearedOnRunExit verifies the binding is removed at the
// terminal point so a late event for a finished run correctly resolves to ""
// (and is dropped). Prevents the binding from leaking / mis-routing a reused
// runID.
func TestUnbindRun_ClearedOnRunExit(t *testing.T) {
	mgr := NewManager(newMockBackend())
	_, _ = mgr.StartSession("route-exit", defaultConfig())

	const runID = "route-exit-1782570666921"
	mgr.mu.Lock()
	mgr.bindRunLocked(runID, "route-exit")
	mgr.sessions["route-exit"].requestID = runID
	mgr.mu.Unlock()

	if got := mgr.keyForRun(runID); got != "route-exit" {
		t.Fatalf("keyForRun before exit: got %q, want route-exit", got)
	}

	// Run exits: handleRunExit clears requestID AND the binding.
	code := 0
	mgr.handleRunExit(runID, &code, nil, "")

	if got := mgr.keyForRun(runID); got != "" {
		t.Fatalf("keyForRun after run exit: got %q, want \"\" (binding must be cleared)", got)
	}
}

// TestUnbindRun_Idempotent confirms unbinding an absent runID is safe.
func TestUnbindRun_Idempotent(t *testing.T) {
	mgr := NewManager(newMockBackend())
	mgr.unbindRun("never-bound") // must not panic
	mgr.mu.Lock()
	mgr.unbindRunLocked("never-bound-locked") // must not panic
	mgr.mu.Unlock()
}
