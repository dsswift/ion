package extcontext

import (
	"errors"
	"testing"
	"time"
)

// Tests for SubAgentPolicy (dispatch-lifecycle root cause B: an empty
// allowlist historically meant "unrestricted", so a leaf specialist handed
// an empty list by its harness could dispatch ANYTHING — including
// re-dispatching its own lead into the depth cap) and for the multi-revive
// fix (root cause D: SignalReviveForSession woke only the FIRST bare-parked
// dispatch on a session).

// TestEligibility_PolicyAllowlist_EmptyDeniesAll pins the leaf semantics:
// under policy "allowlist", an EMPTY AllowedSubAgents denies every nested
// dispatch with ErrSubAgentNotAllowed. Revert bar: on the historic
// non-empty-only check this dispatch is allowed — red.
func TestEligibility_PolicyAllowlist_EmptyDeniesAll(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-ios-dev-leaf-1"
	registerDispatcher(r, dispatcherID, "ios-dev")
	r.SetAllowedSubAgents(dispatcherID, nil) // leaf: no children
	r.SetSubAgentPolicy(dispatcherID, "allowlist")
	sa := &eligibilityTestAccessor{}

	err := checkDispatchEligibility(sa, r, dispatcherID, "dev-lead")
	if !errors.Is(err, ErrSubAgentNotAllowed) {
		t.Fatalf("expected ErrSubAgentNotAllowed for a leaf under policy=allowlist, got %v", err)
	}
}

// TestEligibility_PolicyAllowlist_ReportedChainBlocked pins the exact goat-
// conversation wedge: orchestrator(0) → dev-lead(1) → ios-dev(2, leaf) →
// dev-lead(3). With the policy set, the ELIGIBILITY guard rejects the leaf's
// re-dispatch of its lead — the depth guard never has to fire.
func TestEligibility_PolicyAllowlist_ReportedChainBlocked(t *testing.T) {
	r := NewDispatchRegistry()
	// dev-lead at depth 1 with ios-dev as its only child.
	r.RegisterWithID("dispatch-dev-lead-goat", "dev-lead", func() {}, nil, "elig-test-session", "", 1)
	r.SetAllowedSubAgents("dispatch-dev-lead-goat", []string{"ios-dev"})
	r.SetSubAgentPolicy("dispatch-dev-lead-goat", "allowlist")
	// ios-dev at depth 2, a leaf (empty allowlist) under the same policy.
	r.RegisterWithID("dispatch-ios-dev-goat", "ios-dev", func() {}, nil, "elig-test-session", "dispatch-dev-lead-goat", 2)
	r.SetAllowedSubAgents("dispatch-ios-dev-goat", nil)
	r.SetSubAgentPolicy("dispatch-ios-dev-goat", "allowlist")
	sa := &eligibilityTestAccessor{}

	// The lead may dispatch its child...
	if err := checkDispatchEligibility(sa, r, "dispatch-dev-lead-goat", "ios-dev"); err != nil {
		t.Fatalf("dev-lead -> ios-dev should be allowed, got %v", err)
	}
	// ...but the leaf may dispatch nothing, including its own lead.
	if err := checkDispatchEligibility(sa, r, "dispatch-ios-dev-goat", "dev-lead"); !errors.Is(err, ErrSubAgentNotAllowed) {
		t.Fatalf("ios-dev (leaf) -> dev-lead must be blocked by the allowlist policy, got %v", err)
	}
}

// TestEligibility_PolicyUnset_PreservesHistoricSemantics pins the additive
// contract: with no policy, an empty allowlist still means "no restriction"
// (existing consumers unaffected), and a non-empty one is enforced.
func TestEligibility_PolicyUnset_PreservesHistoricSemantics(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-legacy-1"
	registerDispatcher(r, dispatcherID, "legacy-agent")
	r.SetAllowedSubAgents(dispatcherID, nil) // empty, no policy
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "anything"); err != nil {
		t.Fatalf("policy unset + empty allowlist must impose no restriction, got %v", err)
	}

	r.SetAllowedSubAgents(dispatcherID, []string{"only-this"})
	if err := checkDispatchEligibility(sa, r, dispatcherID, "something-else"); !errors.Is(err, ErrSubAgentNotAllowed) {
		t.Fatalf("policy unset + non-empty allowlist must still enforce membership, got %v", err)
	}
}

// TestEligibility_PolicyUnrestricted_SkipsAllowlist pins the explicit
// opt-out: policy "unrestricted" bypasses the allowlist even when non-empty.
// The self-rail still applies (tested separately via ErrSelfDispatch).
func TestEligibility_PolicyUnrestricted_SkipsAllowlist(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-open-1"
	registerDispatcher(r, dispatcherID, "open-agent")
	r.SetAllowedSubAgents(dispatcherID, []string{"only-this"})
	r.SetSubAgentPolicy(dispatcherID, "unrestricted")
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "something-else"); err != nil {
		t.Fatalf("policy unrestricted must skip the allowlist, got %v", err)
	}
	if err := checkDispatchEligibility(sa, r, dispatcherID, "open-agent"); !errors.Is(err, ErrSelfDispatch) {
		t.Fatalf("self-rail must still apply under policy unrestricted, got %v", err)
	}
}

// TestDispatchRegistry_SubAgentPolicy_SurvivesRegisterUpgrade pins the
// Reserve → RegisterWithID upgrade preserving the policy (RegisterWithID
// replaces the entry; a wholesale replace dropped placeholder flags).
func TestDispatchRegistry_SubAgentPolicy_SurvivesRegisterUpgrade(t *testing.T) {
	r := NewDispatchRegistry()
	r.Reserve("d-pol", "agent", "", 1)
	r.SetSubAgentPolicy("d-pol", "allowlist")
	r.RegisterWithID("d-pol", "agent", func() {}, nil, "sess", "", 1)

	policy, ok := r.SubAgentPolicyForID("d-pol")
	if !ok || policy != "allowlist" {
		t.Fatalf("policy after upgrade = (%q, %v), want (\"allowlist\", true)", policy, ok)
	}
}

// TestDispatchRegistry_SignalReviveForSession_WakesAllBareSuspends pins root
// cause D: with TWO bare-parked dispatches on one session, both revive
// channels are signalled. Revert bar: the first-match-only implementation
// wakes exactly one — red on the second channel's assertion.
func TestDispatchRegistry_SignalReviveForSession_WakesAllBareSuspends(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("d-multi-1", "agent-a", func() {}, nil, "multi-sess", "", 1)
	r.RegisterWithID("d-multi-2", "agent-b", func() {}, nil, "multi-sess", "", 1)

	ch1 := make(chan struct{}, 1)
	ch2 := make(chan struct{}, 1)
	r.SetSuspendedState("d-multi-1", ch1, nil)
	r.SetSuspendedState("d-multi-2", ch2, nil)

	if !r.SignalReviveForSession("multi-sess") {
		t.Fatal("SignalReviveForSession returned false with two bare suspends parked")
	}
	for i, ch := range []chan struct{}{ch1, ch2} {
		select {
		case <-ch:
		case <-time.After(200 * time.Millisecond):
			t.Fatalf("revive channel %d not signalled — only the first bare suspend was woken", i+1)
		}
	}
}

func TestDispatchRegistry_SignalReviveForSession_SkipsAwaitedWork(t *testing.T) {
	for _, tc := range []struct {
		name     string
		children []string
		tasks    []string
		polls    []string
	}{
		{name: "child dispatch", children: []string{"child-z"}},
		{name: "background task", tasks: []string{"bash-z"}},
		{name: "poll", polls: []string{"poll-z"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := NewDispatchRegistry()
			r.RegisterWithID("d-bare", "agent-a", func() {}, nil, "mixed-sess", "", 1)
			r.RegisterWithID("d-waiting", "agent-b", func() {}, nil, "mixed-sess", "", 1)

			bareCh := make(chan struct{}, 1)
			waitingCh := make(chan struct{}, 1)
			r.SetSuspendedState("d-bare", bareCh, nil)
			r.SetSuspendedStateWithWaitingOn("d-waiting", waitingCh, tc.children, tc.tasks, tc.polls)

			if !r.SignalReviveForSession("mixed-sess") {
				t.Fatal("SignalReviveForSession returned false")
			}
			select {
			case <-bareCh:
			case <-time.After(200 * time.Millisecond):
				t.Fatal("bare suspend not woken")
			}
			select {
			case <-waitingCh:
				t.Fatalf("prompt woke dispatch still awaiting %s", tc.name)
			default:
			}
		})
	}
}

// TestDispatchRegistry_Snapshot_SuspendedStatusAndActivity pins items E and
// H1 on the snapshot: a parked entry reports status "suspended" with its
// PendingChildren; UpdateActivity populates ToolCount / LastWork /
// LastActivityMs; an active entry stays "running".
func TestDispatchRegistry_Snapshot_SuspendedStatusAndActivity(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("d-snap-run", "worker", func() {}, nil, "sess", "", 1)
	r.RegisterWithID("d-snap-park", "lead", func() {}, nil, "sess", "", 1)
	r.SetChildConvID("d-snap-run", "conv-worker-1")
	r.UpdateActivity("d-snap-run", 7, "Using Bash...")
	r.SetSuspendedState("d-snap-park", make(chan struct{}, 1), []string{"kid-1", "kid-2"})

	byID := map[string]DispatchStateEntry{}
	for _, e := range r.Snapshot() {
		byID[e.DispatchID] = e
	}

	run := byID["d-snap-run"]
	if run.Status != "running" {
		t.Errorf("active entry status = %q, want running", run.Status)
	}
	if run.ToolCount != 7 {
		t.Errorf("ToolCount = %d, want 7", run.ToolCount)
	}
	if run.LastWork != "Using Bash..." {
		t.Errorf("LastWork = %q, want the snippet", run.LastWork)
	}
	if run.LastActivityMs < 0 || run.LastActivityMs > 5000 {
		t.Errorf("LastActivityMs = %d, want a small recent value", run.LastActivityMs)
	}
	if run.ChildConversationID != "conv-worker-1" {
		t.Errorf("ChildConversationID = %q, want conv-worker-1", run.ChildConversationID)
	}

	park := byID["d-snap-park"]
	if park.Status != "suspended" {
		t.Errorf("parked entry status = %q, want suspended", park.Status)
	}
	if len(park.PendingChildren) != 2 {
		t.Errorf("PendingChildren = %v, want two entries", park.PendingChildren)
	}
	// No activity recorded on the parked entry: zero sentinel, not garbage.
	if park.LastActivityMs != 0 {
		t.Errorf("parked LastActivityMs = %d, want 0 (never observed)", park.LastActivityMs)
	}

	// Clearing the suspend flips the snapshot back to running.
	r.ClearSuspendedState("d-snap-park")
	for _, e := range r.Snapshot() {
		if e.DispatchID == "d-snap-park" && e.Status != "running" {
			t.Errorf("after ClearSuspendedState status = %q, want running", e.Status)
		}
	}
}
