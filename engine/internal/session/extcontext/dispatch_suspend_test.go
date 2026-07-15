package extcontext

import (
	"testing"
	"time"
)

// TestDispatchRegistry_NotifyChildComplete_SignalsWhenSetEmpty pins the
// N-child fan-out revive logic: when all children in PendingChildren complete,
// reviveCh is signaled exactly once. Revert-check: removing the PendingChildren
// decrement in NotifyChildComplete causes this test to fail at the "last child"
// assertion.
func TestDispatchRegistry_NotifyChildComplete_SignalsWhenSetEmpty(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("parent", "lead", func() {}, nil, "sess", "", 1)

	reviveCh := make(chan struct{}, 1)
	r.SetSuspendedState("parent", reviveCh, []string{"child-1", "child-2"})

	// First child — should NOT signal (one child still pending).
	signaled := r.NotifyChildComplete("parent", "child-1")
	if signaled {
		t.Error("NotifyChildComplete must not signal when one child is still pending")
	}
	select {
	case <-reviveCh:
		t.Error("reviveCh signaled too early (one child still pending)")
	default:
	}

	// Second child — set empties, must signal.
	signaled = r.NotifyChildComplete("parent", "child-2")
	if !signaled {
		t.Error("NotifyChildComplete must return true when last pending child completes")
	}
	select {
	case <-reviveCh:
		// Expected.
	case <-time.After(200 * time.Millisecond):
		t.Error("reviveCh not signaled after last pending child completed")
	}
}

// TestDispatchRegistry_SignalReviveForSession_BareSuspend pins bare suspend():
// SignalReviveForSession must signal when PendingChildren is nil (bare
// suspend — revives on the next sendPrompt, regardless of child completion).
func TestDispatchRegistry_SignalReviveForSession_BareSuspend(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp", "agent", func() {}, nil, "my-session", "", 1)

	reviveCh := make(chan struct{}, 1)
	r.SetSuspendedState("disp", reviveCh, nil) // bare suspend: no pending children

	signaled := r.SignalReviveForSession("my-session")
	if !signaled {
		t.Error("SignalReviveForSession must return true for a bare suspend dispatch")
	}
	select {
	case <-reviveCh:
		// Expected.
	case <-time.After(200 * time.Millisecond):
		t.Error("reviveCh not signaled for bare suspend")
	}
}

// TestDispatchRegistry_SignalReviveForSession_DoesNotSignalWithPendingChildren
// pins that SignalReviveForSession does NOT signal when PendingChildren is
// non-empty (suspendUntilAll case — only NotifyChildComplete may drive revive).
// Revert-check: removing the PendingChildren nil-check in SignalReviveForSession
// causes this test to fail.
func TestDispatchRegistry_SignalReviveForSession_DoesNotSignalWithPendingChildren(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("disp2", "agent", func() {}, nil, "my-session2", "", 1)

	reviveCh := make(chan struct{}, 1)
	r.SetSuspendedState("disp2", reviveCh, []string{"child-1"}) // suspendUntilAll

	signaled := r.SignalReviveForSession("my-session2")
	if signaled {
		t.Error("SignalReviveForSession must not signal when PendingChildren is non-empty")
	}
	select {
	case <-reviveCh:
		t.Error("reviveCh signaled unexpectedly with non-empty PendingChildren")
	default:
	}
}

// TestDispatchRegistry_SetClearSuspendedState_Roundtrip verifies the basic
// set/clear cycle: after ClearSuspendedState, ReviveCh and PendingChildren
// are nil, and subsequent SignalReviveForSession is a no-op.
func TestDispatchRegistry_SetClearSuspendedState_Roundtrip(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("d3", "a", func() {}, nil, "sess3", "", 1)

	reviveCh := make(chan struct{}, 1)
	r.SetSuspendedState("d3", reviveCh, nil)

	// Clear before signal — no-op for SignalReviveForSession.
	r.ClearSuspendedState("d3")
	signaled := r.SignalReviveForSession("sess3")
	if signaled {
		t.Error("SignalReviveForSession must not signal after ClearSuspendedState")
	}
}
