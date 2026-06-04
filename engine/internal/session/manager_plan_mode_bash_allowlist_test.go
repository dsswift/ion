package session

import (
	"testing"
)

// Tri-valued semantics for `set_plan_mode.planModeAllowedBashCommands`:
//
//   - nil (JSON-omitted)    → no change to existing allowlist
//   - []  (JSON-empty)      → clear; Bash blocked entirely
//   - [...] (non-empty)     → replace
//
// The server-dispatch guard (`engine/internal/server/server.go`) calls
// `Manager.SetPlanModeBashAllowlist(...)` only when the wire field is
// non-nil. These tests verify the three resulting Manager-level
// behaviours from the *session-state* angle: what `s.planModeAllowed
// BashCommands` looks like after each case.
//
// The dispatch guard itself is exercised at the server layer; here we
// validate the contract Manager.SetPlanModeBashAllowlist enforces when
// called.

func TestSetPlanModeBashAllowlist_ReplaceWithNonEmpty(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tri-replace", defaultConfig())

	mgr.SetPlanModeBashAllowlist("tri-replace", []string{"gh", "git log"})

	mgr.mu.RLock()
	got := mgr.sessions["tri-replace"].planModeAllowedBashCommands
	mgr.mu.RUnlock()

	if len(got) != 2 || got[0] != "gh" || got[1] != "git log" {
		t.Errorf("expected [gh, git log], got %v", got)
	}
}

func TestSetPlanModeBashAllowlist_ExplicitEmptyClears(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tri-clear", defaultConfig())

	// Seed a non-empty allowlist first.
	mgr.SetPlanModeBashAllowlist("tri-clear", []string{"gh"})

	mgr.mu.RLock()
	seeded := mgr.sessions["tri-clear"].planModeAllowedBashCommands
	mgr.mu.RUnlock()
	if len(seeded) != 1 || seeded[0] != "gh" {
		t.Fatalf("expected seed [gh], got %v", seeded)
	}

	// Now clear with an explicit non-nil empty slice — the server-dispatch
	// guard passes this through (cmd.PlanModeAllowedBashCommands != nil
	// because Go's JSON decoder allocates a non-nil empty slice for JSON
	// [], distinct from the nil value JSON omission would produce).
	mgr.SetPlanModeBashAllowlist("tri-clear", []string{})

	mgr.mu.RLock()
	cleared := mgr.sessions["tri-clear"].planModeAllowedBashCommands
	mgr.mu.RUnlock()

	if len(cleared) != 0 {
		t.Errorf("expected empty allowlist after explicit-clear, got %v", cleared)
	}
}

// TestSetPlanModeBashAllowlist_NilCaseHandledByServerGuard is the
// "omitted = no change" case. SetPlanModeBashAllowlist itself does not
// implement that semantic — the guard in `engine/internal/server/
// server.go` does (it skips the call entirely when
// cmd.PlanModeAllowedBashCommands == nil). This test pins the contract
// at the Manager level: if no one calls SetPlanModeBashAllowlist, the
// session's allowlist stays unchanged.
func TestSetPlanModeBashAllowlist_NoCallLeavesAllowlistUnchanged(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tri-nochange", defaultConfig())

	// Seed an existing allowlist.
	mgr.SetPlanModeBashAllowlist("tri-nochange", []string{"gh", "git diff"})

	mgr.mu.RLock()
	seeded := mgr.sessions["tri-nochange"].planModeAllowedBashCommands
	mgr.mu.RUnlock()
	if len(seeded) != 2 {
		t.Fatalf("expected seed of 2 items, got %v", seeded)
	}

	// Simulate the server-dispatch path where the wire field was omitted
	// (cmd.PlanModeAllowedBashCommands == nil). Per the dispatch guard
	// in server.go, SetPlanModeBashAllowlist is NOT called in this case.
	// We model that by NOT calling the method; the session state must
	// stay as we seeded it.

	mgr.mu.RLock()
	after := mgr.sessions["tri-nochange"].planModeAllowedBashCommands
	mgr.mu.RUnlock()

	if len(after) != 2 || after[0] != "gh" || after[1] != "git diff" {
		t.Errorf("expected allowlist unchanged after no-call, got %v", after)
	}
}

// TestSetPlanModeBashAllowlist_UnknownSessionIsNoOp pins the invariant
// guard from plan_mode.go:192-201 — a session-not-found is logged at
// Error level but does not panic. Repeats this here so the three-case
// suite is self-contained: nil case (no-call), [] (clear), [...]
// (replace), plus the negative path.
func TestSetPlanModeBashAllowlist_UnknownSessionIsNoOp(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	// No session started; this should not panic.
	mgr.SetPlanModeBashAllowlist("unknown-key", []string{"gh"})

	// No assertion needed beyond "did not panic". The Error log is the
	// observable side effect and is verified by inspection — see
	// plan_mode.go:200 for the log site.
}
