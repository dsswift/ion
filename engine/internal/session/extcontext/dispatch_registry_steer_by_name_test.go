package extcontext

import (
	"slices"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

// TestDispatchRegistry_SteerOwnedByName_Delivered verifies that SteerOwnedByName
// resolves the agent name to its dispatch ID and delivers the steer when
// the child backend accepts it.
func TestDispatchRegistry_SteerOwnedByName_Delivered(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-reviewer-111", "code-reviewer", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-reviewer-111", "sess-1-dispatch-reviewer-111")

	outcome := r.SteerOwnedByName("", "code-reviewer", "focus on error handling").Outcome

	if outcome != SteerOutcomeDelivered {
		t.Fatalf("SteerOwnedByName outcome = %q, want %q", outcome, SteerOutcomeDelivered)
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

// TestDispatchRegistry_SteerOwnedByName_NotFound verifies that SteerOwnedByName returns
// SteerOutcomeNotFound when no dispatch with the given name exists.
func TestDispatchRegistry_SteerOwnedByName_NotFound(t *testing.T) {
	r := NewDispatchRegistry()

	outcome := r.SteerOwnedByName("", "nonexistent-agent", "hello").Outcome

	if outcome != SteerOutcomeNotFound {
		t.Fatalf("SteerOwnedByName outcome = %q, want %q", outcome, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_SteerOwnedByName_NotFoundAfterDeregister verifies that
// SteerOwnedByName returns not_found after the dispatch has been deregistered.
func TestDispatchRegistry_SteerOwnedByName_NotFoundAfterDeregister(t *testing.T) {
	r := NewDispatchRegistry()
	// Use nil child so Deregister's invariant check (d.Child != nil guard)
	// is skipped — this test is about name resolution, not child lifecycle.
	r.RegisterWithID("dispatch-gone-aaa", "gone-agent", func() {}, nil, "sess-1", "", 0)
	r.Deregister("dispatch-gone-aaa", DispatchOutcome{Status: DispatchStatusDone})

	outcome := r.SteerOwnedByName("", "gone-agent", "too late").Outcome

	if outcome != SteerOutcomeNotFound {
		t.Fatalf("SteerOwnedByName after deregister = %q, want %q", outcome, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_SteerOwnedByName_MultipleSameNameIsAmbiguous pins that when
// several live dispatches share a name, SteerOwnedByName delivers to none of them
// and returns the ambiguous outcome with every matching ID, sorted.
func TestDispatchRegistry_SteerOwnedByName_MultipleSameNameIsAmbiguous(t *testing.T) {
	r := NewDispatchRegistry()
	childA := &mockSteerableBackend{result: backend.SteerResultDelivered}
	childB := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-agent-bbb", "shared-agent", func() {}, childB, "sess-1", "", 0)
	r.SetChildRunID("dispatch-agent-bbb", "run-bbb")
	r.RegisterWithID("dispatch-agent-aaa", "shared-agent", func() {}, childA, "sess-1", "", 0)
	r.SetChildRunID("dispatch-agent-aaa", "run-aaa")

	res := r.SteerOwnedByName("", "shared-agent", "redirect")
	outcome, matching := res.Outcome, res.MatchingIDs

	if outcome != SteerOutcomeAmbiguous {
		t.Fatalf("SteerOwnedByName outcome = %q, want %q", outcome, SteerOutcomeAmbiguous)
	}
	if want := []string{"dispatch-agent-aaa", "dispatch-agent-bbb"}; !slices.Equal(matching, want) {
		t.Errorf("matching IDs = %v, want %v", matching, want)
	}
	if childA.called || childB.called {
		t.Errorf("an ambiguous steer reached a child (childA.called=%v, childB.called=%v)", childA.called, childB.called)
	}
}

// TestDispatchRegistry_SteerOwnedByName_UniqueMatchReturnsNoIDs pins that a single
// match behaves as before: it delivers and carries no matching-ID list.
func TestDispatchRegistry_SteerOwnedByName_UniqueMatchReturnsNoIDs(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("dispatch-solo", "solo", func() {}, &mockSteerableBackend{result: backend.SteerResultDelivered}, "sess-1", "", 0)
	r.SetChildRunID("dispatch-solo", "run-solo")
	// A different name must not count toward the match set.
	r.RegisterWithID("dispatch-other", "other", func() {}, &mockSteerableBackend{result: backend.SteerResultDelivered}, "sess-1", "", 0)

	res := r.SteerOwnedByName("", "solo", "go")
	outcome, matching := res.Outcome, res.MatchingIDs
	if outcome != SteerOutcomeDelivered || matching != nil {
		t.Fatalf("SteerOwnedByName = (%q, %v), want (%q, nil)", outcome, matching, SteerOutcomeDelivered)
	}
}

// TestDispatchRegistry_SteerOwnedByName_ChildRunNotYetActive verifies that
// SteerOwnedByName returns SteerOutcomeNoRun when the registry entry exists but
// the child backend has no active run for the stored ChildRunID.
func TestDispatchRegistry_SteerOwnedByName_ChildRunNotYetActive(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultNoRun}

	r.RegisterWithID("dispatch-pending-aaa", "pending-agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-pending-aaa", "run-not-started-yet")

	outcome := r.SteerOwnedByName("", "pending-agent", "early steer").Outcome

	if outcome != SteerOutcomeNoRun {
		t.Fatalf("SteerOwnedByName (no active run) = %q, want %q", outcome, SteerOutcomeNoRun)
	}
}

// TestDispatchRegistry_SteerOwnedByName_ChannelFull verifies SteerOutcomeChannelFull
// propagates through the name-based path correctly.
func TestDispatchRegistry_SteerOwnedByName_ChannelFull(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultChannelFull}

	r.RegisterWithID("dispatch-full-aaa", "busy-agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-full-aaa", "run-full")

	outcome := r.SteerOwnedByName("", "busy-agent", "overflow").Outcome

	if outcome != SteerOutcomeChannelFull {
		t.Fatalf("SteerOwnedByName (channel full) = %q, want %q", outcome, SteerOutcomeChannelFull)
	}
}
