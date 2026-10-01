package extcontext

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

// Tests for the dispatch-steering addressing fixes: consumer-id aliasing,
// deterministic same-name resolution, and the not-yet-started outcome.
//
// Each test here fails on the pre-fix code. Reverting the corresponding change
// turns it red, which is what makes it a regression test rather than a
// restatement of current behavior.

// --- Consumer dispatch ID aliases ---

// TestDispatchRegistry_SteerByID_ResolvesConsumerAlias is the regression test
// for the production defect: a harness minted its own dispatch key, steered
// with it, and the registry answered not_found for a dispatch that was very
// much alive. Every steer aimed at that dispatch was silently dropped for its
// entire lifetime.
//
// Before the alias map, SteerByID did a bare map lookup on the supplied id, so
// this returns SteerOutcomeNotFound and the child is never called.
func TestDispatchRegistry_SteerByID_ResolvesConsumerAlias(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	const canonical = "dispatch-dev-lead-1787795586440-6f8e281ecd70"
	const consumerID = "local-1787795586436-47f66a"

	r.RegisterWithID(canonical, "dev-lead", func(string) {}, child, "sess-1", "", 1)
	r.SetChildRunID(canonical, "sess-1-"+canonical)
	r.RegisterAlias(consumerID, canonical)

	outcome := r.SteerByID(consumerID, "change course")

	if outcome != SteerOutcomeDelivered {
		t.Fatalf("SteerByID(consumer alias) = %q, want %q", outcome, SteerOutcomeDelivered)
	}
	if !child.called {
		t.Fatal("child backend never received the steer")
	}
	// The child must be addressed by its real run id, not the alias: the alias
	// is an addressing convenience at the registry edge and must never leak
	// into the backend's run lookup.
	if child.lastRunID != "sess-1-"+canonical {
		t.Errorf("child received runID = %q, want %q", child.lastRunID, "sess-1-"+canonical)
	}
	if child.lastMessage != "change course" {
		t.Errorf("child received message = %q, want %q", child.lastMessage, "change course")
	}
}

// TestDispatchRegistry_Alias_DroppedOnDeregister pins that an alias never
// outlives its dispatch. A consumer that reuses its own key across dispatches
// (a counter, a name-derived key) would otherwise have a stale alias silently
// redirect a new steer onto a dead entry — a worse failure than the not_found
// the alias exists to remove, because it looks like success.
func TestDispatchRegistry_Alias_DroppedOnDeregister(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-a", "agent", func(string) {}, child, "sess-1", "", 1)
	r.SetChildRunID("dispatch-a", "run-a")
	r.RegisterAlias("local-1", "dispatch-a")

	if got := r.SteerByID("local-1", "first"); got != SteerOutcomeDelivered {
		t.Fatalf("pre-deregister steer = %q, want %q", got, SteerOutcomeDelivered)
	}

	r.Deregister("dispatch-a", DispatchOutcome{Status: DispatchStatusDone})

	if got := r.SteerByID("local-1", "second"); got != SteerOutcomeNotFound {
		t.Fatalf("post-deregister steer via stale alias = %q, want %q", got, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_Alias_NeverRebinds pins that a duplicate consumer key
// does not silently repoint to a second dispatch. If a consumer's keys are not
// unique the engine must keep the first binding and say so, rather than pick a
// winner and route steers to whichever dispatch registered last.
func TestDispatchRegistry_Alias_NeverRebinds(t *testing.T) {
	r := NewDispatchRegistry()
	first := &mockSteerableBackend{result: backend.SteerResultDelivered}
	second := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-first", "agent", func(string) {}, first, "sess-1", "", 1)
	r.SetChildRunID("dispatch-first", "run-first")
	r.RegisterWithID("dispatch-second", "agent", func(string) {}, second, "sess-1", "", 1)
	r.SetChildRunID("dispatch-second", "run-second")

	r.RegisterAlias("dup", "dispatch-first")
	r.RegisterAlias("dup", "dispatch-second") // must be refused

	if got := r.SteerByID("dup", "hello"); got != SteerOutcomeDelivered {
		t.Fatalf("steer via alias = %q, want %q", got, SteerOutcomeDelivered)
	}
	if !first.called {
		t.Error("alias rebound away from its original dispatch")
	}
	if second.called {
		t.Error("alias rebound to the later dispatch; the first binding must win")
	}
}

// TestDispatchRegistry_Alias_NeverShadowsCanonicalID pins lookup precedence: a
// consumer key that happens to equal another dispatch's canonical ID must not
// hijack it. The engine's own ID space is authoritative.
func TestDispatchRegistry_Alias_NeverShadowsCanonicalID(t *testing.T) {
	r := NewDispatchRegistry()
	real := &mockSteerableBackend{result: backend.SteerResultDelivered}
	other := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-real", "agent", func(string) {}, real, "sess-1", "", 1)
	r.SetChildRunID("dispatch-real", "run-real")
	r.RegisterWithID("dispatch-other", "agent", func(string) {}, other, "sess-1", "", 1)
	r.SetChildRunID("dispatch-other", "run-other")

	// A pathological alias pointing an existing canonical id elsewhere.
	r.RegisterAlias("dispatch-real", "dispatch-other")

	if got := r.SteerByID("dispatch-real", "hello"); got != SteerOutcomeDelivered {
		t.Fatalf("steer = %q, want %q", got, SteerOutcomeDelivered)
	}
	if !real.called {
		t.Error("direct canonical lookup did not win over the alias")
	}
	if other.called {
		t.Error("alias shadowed a live canonical dispatch id")
	}
}

// --- Not-yet-started dispatches ---

// TestDispatchRegistry_SteerByID_ReservedReportsNoRun pins that a reserved
// placeholder reports no_run — the honest, retryable answer.
//
// Before the fix a reserved entry fell through to the Steerable assertion with
// a nil Child and was reported as "child backend does not implement steerable",
// which named the wrong cause entirely: there is no backend yet, so the backend
// type is irrelevant, and a caller reading that log would go hunting for a
// missing interface implementation instead of simply retrying.
func TestDispatchRegistry_SteerByID_ReservedReportsNoRun(t *testing.T) {
	r := NewDispatchRegistry()
	r.Reserve("dispatch-pending", "agent", "", 1)

	if got := r.SteerByID("dispatch-pending", "too early"); got != SteerOutcomeNoRun {
		t.Fatalf("steer to reserved dispatch = %q, want %q", got, SteerOutcomeNoRun)
	}
}

// TestDispatchRegistry_SteerByID_RegisteredWithoutChildRunIDReportsNoRun
// covers the window between RegisterWithID and SetChildRunID: the entry is
// real but has no run to reach yet.
func TestDispatchRegistry_SteerByID_RegisteredWithoutChildRunIDReportsNoRun(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	r.RegisterWithID("dispatch-nochild", "agent", func(string) {}, child, "sess-1", "", 1)
	// SetChildRunID deliberately not called.

	if got := r.SteerByID("dispatch-nochild", "early"); got != SteerOutcomeNoRun {
		t.Fatalf("steer before child run id = %q, want %q", got, SteerOutcomeNoRun)
	}
	if child.called {
		t.Error("steer was forwarded to a backend with no known run id")
	}
}

// --- Recall accepts the same id space as steer ---

// TestDispatchRegistry_RecallByID_ResolvesConsumerAlias pins that recall and
// steer accept the identical id space.
//
// The asymmetry this prevents is worse than a failed steer: a harness whose
// recall silently misses believes it cancelled a dispatch that is in fact still
// running and still spending tokens. ion-dev's dispatch timeout was written
// around exactly this — it refused to recall while it held a local id, which
// meant a dispatch that wedged before the engine's id arrived could never be
// recalled at all.
func TestDispatchRegistry_RecallByID_ResolvesConsumerAlias(t *testing.T) {
	r := NewDispatchRegistry()
	cancelled := false
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-real", "agent", func(string) { cancelled = true }, child, "sess-1", "", 1)
	r.SetChildRunID("dispatch-real", "run-real")
	r.RegisterAlias("local-42", "dispatch-real")

	if !r.RecallByID("local-42", "timeout") {
		t.Fatal("RecallByID(consumer alias) reported not found for a live dispatch")
	}
	if !cancelled {
		t.Error("the dispatch's cancel func was never invoked")
	}
	// The alias must not survive the recall, or a reused consumer key would
	// resolve onto a dispatch that no longer exists.
	if _, _, ok := r.resolveIDLocked("local-42"); ok {
		t.Error("alias outlived the recalled dispatch")
	}
}

// TestDispatchRegistry_RecallByID_UnknownIDStillReportsNotFound pins that alias
// resolution did not weaken the miss case into a false success.
func TestDispatchRegistry_RecallByID_UnknownIDStillReportsNotFound(t *testing.T) {
	r := NewDispatchRegistry()
	if r.RecallByID("no-such-dispatch", "timeout") {
		t.Error("RecallByID reported success for an unknown dispatch id")
	}
}
