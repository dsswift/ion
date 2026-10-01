package extcontext

import (
	"slices"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
)

// controlTree builds root -> a -> a1 and root -> b, all steerable.
//
//	a  (lead)    b (lead)
//	a1 (worker)
func controlTree(t *testing.T) (*DispatchRegistry, map[string]*mockSteerableBackend) {
	t.Helper()
	r := NewDispatchRegistry()
	children := map[string]*mockSteerableBackend{}
	for _, d := range []struct{ id, name, parent string }{
		{"a", "lead", ""}, {"a1", "worker", "a"}, {"b", "lead", ""},
	} {
		child := &mockSteerableBackend{result: backend.SteerResultDelivered}
		children[d.id] = child
		depth := 1
		if d.parent != "" {
			depth = 2
		}
		r.RegisterWithID(d.id, d.name, func(string) {}, child, "sess", d.parent, depth)
		r.SetChildRunID(d.id, "run-"+d.id)
	}
	return r, children
}

// TestSteerOwnedByID_Authorization pins the ownership rule on steer: the root
// steers anything, a dispatched agent only its strict descendants.
func TestSteerOwnedByID_Authorization(t *testing.T) {
	r, children := controlTree(t)
	cases := []struct {
		owner, target string
		want          SteerDispatchOutcome
	}{
		{"", "a1", SteerOutcomeDelivered},
		{"a", "a1", SteerOutcomeDelivered},
		{"a", "a", SteerOutcomeUnauthorized},  // self
		{"a1", "a", SteerOutcomeUnauthorized}, // ancestor
		{"a", "b", SteerOutcomeUnauthorized},  // sibling branch
		{"a", "nope", SteerOutcomeNotFound},
	}
	for _, tc := range cases {
		if got := r.SteerOwnedByID(tc.owner, tc.target, "msg").Outcome; got != tc.want {
			t.Errorf("SteerOwnedByID(%q, %q) = %q, want %q", tc.owner, tc.target, got, tc.want)
		}
	}
	if children["b"].called {
		t.Error("an unauthorized steer reached the sibling")
	}
}

// TestSteerOwnedByID_CompletedRace pins that a steer aimed at a dispatch that
// already finished answers "completed" with the terminal entry, through both
// the canonical ID and the consumer alias, and never "not_found".
func TestSteerOwnedByID_CompletedRace(t *testing.T) {
	r, _ := controlTree(t)
	r.RegisterAlias("local-a1", "a1")
	r.Deregister("a1", DispatchOutcome{Status: DispatchStatusDone})

	for _, id := range []string{"a1", "local-a1"} {
		got := r.SteerOwnedByID("a", id, "too late")
		if got.Outcome != SteerOutcomeCompleted || got.Terminal == nil || got.Terminal.DispatchID != "a1" || got.Terminal.Status != DispatchStatusDone {
			t.Errorf("SteerOwnedByID(a, %q) = %+v, want completed with a1's terminal entry", id, got)
		}
	}
	if got := r.SteerOwnedByID("b", "a1", "not yours").Outcome; got != SteerOutcomeUnauthorized {
		t.Errorf("finished dispatch steered by a non-owner = %q, want unauthorized", got)
	}
}

// TestSteerOwnedByName_SearchesOwnedScope pins that name lookup searches the
// same scope as ID lookup: a sibling's same-name dispatch is invisible, and an
// ambiguity lists only dispatches the caller owns.
func TestSteerOwnedByName_SearchesOwnedScope(t *testing.T) {
	r, children := controlTree(t)
	// b gets its own "worker" child: same name as a1, different branch.
	bChild := &mockSteerableBackend{result: backend.SteerResultDelivered}
	r.RegisterWithID("b1", "worker", func(string) {}, bChild, "sess", "b", 2)
	r.SetChildRunID("b1", "run-b1")

	if got := r.SteerOwnedByName("a", "worker", "msg"); got.Outcome != SteerOutcomeDelivered || !children["a1"].called || bChild.called {
		t.Fatalf("a's name steer = %+v, want delivered to a1 only", got)
	}
	if got := r.SteerOwnedByName("a", "lead", "msg").Outcome; got != SteerOutcomeNotFound {
		t.Fatalf("a's steer of a name it owns nothing under = %q, want not_found", got)
	}
	got := r.SteerOwnedByName("", "worker", "msg")
	if got.Outcome != SteerOutcomeAmbiguous || !slices.Equal(got.MatchingIDs, []string{"a1", "b1"}) {
		t.Fatalf("root's name steer = %+v, want ambiguous over [a1 b1]", got)
	}
}

// TestRecallOwnedByID_CompletedAndUnauthorized pins recall's typed outcomes
// for a finished target.
func TestRecallOwnedByID_CompletedAndUnauthorized(t *testing.T) {
	r, _ := controlTree(t)
	r.Deregister("a1", DispatchOutcome{Status: DispatchStatusError, Reason: "boom", ExitCode: 1})

	got := r.RecallOwnedByID("a", "a1", "stop")
	if got.Outcome != RecallOutcomeCompleted || got.Terminal == nil || got.Terminal.Reason != "boom" {
		t.Fatalf("recall of a finished owned dispatch = %+v, want completed with its terminal entry", got)
	}
	if got := r.RecallOwnedByID("b", "a1", "stop").Outcome; got != RecallOutcomeUnauthorized {
		t.Fatalf("recall of a finished unowned dispatch = %q, want unauthorized", got)
	}
	if got := r.RecallOwnedByID("", "never", "stop").Outcome; got != RecallOutcomeNotFound {
		t.Fatalf("recall of an unknown id = %q, want not_found", got)
	}
}

// TestOwnership_WalksThroughFinishedParent pins that a parent keeps authority
// over a live grandchild after the intermediate child finished. The walk used
// to fail closed on the missing link.
func TestOwnership_WalksThroughFinishedParent(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("a", "lead", func(string) {}, nil, "sess", "", 1)
	r.RegisterWithID("a1", "worker", func(string) {}, nil, "sess", "a", 2)
	r.RegisterWithID("a2", "helper", func(string) {}, nil, "sess", "a1", 3)
	r.Deregister("a1", DispatchOutcome{Status: DispatchStatusDone})

	if owned, found := r.OwnsDispatch("a", "a2"); !found || !owned {
		t.Fatalf("OwnsDispatch(a, a2) = (%v, %v), want (true, true)", owned, found)
	}
	snap := r.OwnedSnapshot("a")
	if len(snap) != 1 || snap[0].DispatchID != "a2" {
		t.Fatalf("a's live view = %+v, want only a2", snap)
	}
}

// TestControl_CrossRegistryIsUnauthorizedAndReported pins the mismatch
// report: a request against one registry for a dispatch another registry
// holds live answers unauthorized and reports both registries.
func TestControl_CrossRegistryIsUnauthorizedAndReported(t *testing.T) {
	holder := NewDispatchRegistry()
	holder.RegisterWithID("held-1", "worker", func(string) {}, nil, "other-session", "", 1)
	holder.RegisterAlias("local-held", "held-1")
	t.Cleanup(func() { holder.RecallAll("test cleanup") })

	resolver := NewDispatchRegistry()
	var reports []ControlMismatch
	resolver.SetControlMismatchObserver(func(m ControlMismatch) { reports = append(reports, m) })

	if got := resolver.SteerOwnedByID("", "held-1", "msg").Outcome; got != SteerOutcomeUnauthorized {
		t.Fatalf("cross-registry steer = %q, want unauthorized", got)
	}
	if got := resolver.RecallOwnedByID("", "local-held", "stop").Outcome; got != RecallOutcomeUnauthorized {
		t.Fatalf("cross-registry recall by alias = %q, want unauthorized", got)
	}
	if _, live := holder.Get("held-1"); !live {
		t.Fatal("a cross-registry recall cancelled the held dispatch")
	}
	if len(reports) != 2 {
		t.Fatalf("mismatch reports = %d, want 2: %+v", len(reports), reports)
	}
	steer, recall := reports[0], reports[1]
	if steer.Operation != "steer" || steer.Outcome != "unauthorized" || steer.DispatchID != "held-1" ||
		steer.HoldingRegistry != holder.seq || steer.ResolvingRegistry != resolver.seq ||
		steer.HoldingSessionID != "other-session" || steer.LifecycleState != "running" {
		t.Errorf("steer report = %+v", steer)
	}
	if recall.Operation != "recall" || recall.DispatchID != "local-held" {
		t.Errorf("recall report = %+v", recall)
	}

	// Once the holder releases it, the same request is plainly not found and
	// reports nothing.
	holder.Deregister("held-1", DispatchOutcome{Status: DispatchStatusDone})
	if got := resolver.SteerOwnedByID("", "held-1", "msg").Outcome; got != SteerOutcomeNotFound {
		t.Fatalf("steer after release = %q, want not_found", got)
	}
	if len(reports) != 2 {
		t.Fatalf("a plain miss was reported as a mismatch: %+v", reports[2:])
	}
}

// TestTerminalObserver_ReceivesEveryRetirement pins that each path that ends
// a dispatch hands its terminal entry to the observer for persistence.
func TestTerminalObserver_ReceivesEveryRetirement(t *testing.T) {
	r := NewDispatchRegistry()
	var seen []string
	r.SetTerminalObserver(func(entries []DispatchTerminalEntry) {
		for _, e := range entries {
			seen = append(seen, e.DispatchID+":"+e.Status)
		}
	})
	r.RegisterWithID("done-1", "w", func(string) {}, nil, "s", "", 1)
	r.RegisterWithID("recalled-1", "w", func(string) {}, nil, "s", "", 1)
	r.RegisterWithID("recalled-1a", "w", func(string) {}, nil, "s", "recalled-1", 2)
	r.RegisterWithID("torn-down-1", "w", func(string) {}, nil, "s", "", 1)

	r.Deregister("done-1", DispatchOutcome{Status: DispatchStatusDone})
	r.RecallByID("recalled-1", "stop")
	r.RecallAll("teardown")

	want := []string{"done-1:done", "recalled-1:cancelled", "recalled-1a:cancelled", "torn-down-1:cancelled"}
	if !slices.Equal(seen, want) {
		t.Fatalf("observer saw %v, want %v", seen, want)
	}
}

// TestSeedHistory_OrdersAndDedupes pins restart seeding: entries land in
// completion order, a retained ID is not duplicated, and the bound applies.
func TestSeedHistory_OrdersAndDedupes(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("live-done", "w", func(string) {}, nil, "s", "", 1)
	r.Deregister("live-done", DispatchOutcome{Status: DispatchStatusDone})

	now := time.Now()
	r.SeedHistory([]DispatchTerminalEntry{
		{DispatchID: "late", Status: DispatchStatusLost, CompletedAt: now.Add(-time.Minute)},
		{DispatchID: "early", Status: DispatchStatusDone, CompletedAt: now.Add(-2 * time.Minute)},
		{DispatchID: "live-done", Status: DispatchStatusDone, CompletedAt: now.Add(-3 * time.Minute)},
	})
	if got, want := historyIDs(r.History()), []string{"early", "late", "live-done"}; !slices.Equal(got, want) {
		t.Fatalf("history = %v, want %v", got, want)
	}
}
