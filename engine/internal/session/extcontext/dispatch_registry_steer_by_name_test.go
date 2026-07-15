package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

// TestDispatchRegistry_SteerByName_Delivered verifies that SteerByName
// resolves the agent name to its dispatch ID and delivers the steer when
// the child backend accepts it.
func TestDispatchRegistry_SteerByName_Delivered(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-reviewer-111", "code-reviewer", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-reviewer-111", "sess-1-dispatch-reviewer-111")

	outcome := r.SteerByName("code-reviewer", "focus on error handling")

	if outcome != SteerOutcomeDelivered {
		t.Fatalf("SteerByName outcome = %q, want %q", outcome, SteerOutcomeDelivered)
	}
	if !child.called {
		t.Fatal("child.SteerWithReason was not called")
	}
	if child.lastRunID != "sess-1-dispatch-reviewer-111" {
		t.Errorf("child received runID = %q, want %q", child.lastRunID, "sess-1-dispatch-reviewer-111")
	}
	if child.lastMessage != "focus on error handling" {
		t.Errorf("child received message = %q, want %q", child.lastMessage, "focus on error handling")
	}
}

// TestDispatchRegistry_SteerByName_NotFound verifies that SteerByName returns
// SteerOutcomeNotFound when no dispatch with the given name exists.
func TestDispatchRegistry_SteerByName_NotFound(t *testing.T) {
	r := NewDispatchRegistry()

	outcome := r.SteerByName("nonexistent-agent", "hello")

	if outcome != SteerOutcomeNotFound {
		t.Fatalf("SteerByName outcome = %q, want %q", outcome, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_SteerByName_NotFoundAfterDeregister verifies that
// SteerByName returns not_found after the dispatch has been deregistered.
func TestDispatchRegistry_SteerByName_NotFoundAfterDeregister(t *testing.T) {
	r := NewDispatchRegistry()
	// Use nil child so Deregister's invariant check (d.Child != nil guard)
	// is skipped — this test is about name resolution, not child lifecycle.
	r.RegisterWithID("dispatch-gone-aaa", "gone-agent", func() {}, nil, "sess-1", "", 0)
	r.Deregister("dispatch-gone-aaa")

	outcome := r.SteerByName("gone-agent", "too late")

	if outcome != SteerOutcomeNotFound {
		t.Fatalf("SteerByName after deregister = %q, want %q", outcome, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_SteerByName_MultipleSameNameSteersFirst verifies that
// when multiple dispatches share a name, SteerByName delivers to one of them
// (non-deterministic). The assertion is that the outcome is delivered and
// exactly one of the two children received the steer.
func TestDispatchRegistry_SteerByName_MultipleSameNameSteersFirst(t *testing.T) {
	r := NewDispatchRegistry()
	childA := &mockSteerableBackend{result: backend.SteerResultDelivered}
	childB := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-agent-aaa", "shared-agent", func() {}, childA, "sess-1", "", 0)
	r.SetChildRunID("dispatch-agent-aaa", "run-aaa")
	r.RegisterWithID("dispatch-agent-bbb", "shared-agent", func() {}, childB, "sess-1", "", 0)
	r.SetChildRunID("dispatch-agent-bbb", "run-bbb")

	outcome := r.SteerByName("shared-agent", "redirect")

	if outcome != SteerOutcomeDelivered {
		t.Fatalf("SteerByName outcome = %q, want %q", outcome, SteerOutcomeDelivered)
	}
	// Exactly one of the two children must have been steered.
	calledCount := 0
	if childA.called {
		calledCount++
	}
	if childB.called {
		calledCount++
	}
	if calledCount != 1 {
		t.Errorf("expected exactly 1 child steered, got %d (childA.called=%v, childB.called=%v)",
			calledCount, childA.called, childB.called)
	}
}

// TestDispatchRegistry_SteerByName_ChildRunNotYetActive verifies that
// SteerByName returns SteerOutcomeNoRun when the registry entry exists but
// the child backend has no active run for the stored ChildRunID.
func TestDispatchRegistry_SteerByName_ChildRunNotYetActive(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultNoRun}

	r.RegisterWithID("dispatch-pending-aaa", "pending-agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-pending-aaa", "run-not-started-yet")

	outcome := r.SteerByName("pending-agent", "early steer")

	if outcome != SteerOutcomeNoRun {
		t.Fatalf("SteerByName (no active run) = %q, want %q", outcome, SteerOutcomeNoRun)
	}
}

// TestDispatchRegistry_SteerByName_ChannelFull verifies SteerOutcomeChannelFull
// propagates through the name-based path correctly.
func TestDispatchRegistry_SteerByName_ChannelFull(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultChannelFull}

	r.RegisterWithID("dispatch-full-aaa", "busy-agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-full-aaa", "run-full")

	outcome := r.SteerByName("busy-agent", "overflow")

	if outcome != SteerOutcomeChannelFull {
		t.Fatalf("SteerByName (channel full) = %q, want %q", outcome, SteerOutcomeChannelFull)
	}
}
