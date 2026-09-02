package extcontext

import (
	"errors"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
)

// Tests for the harness-declared per-name dispatch concurrency cap.
//
// The engine owns the count because only the registry knows what is live; the
// harness owns the number because "which agents are singletons" is policy. The
// cap is scoped per PARENT, which is what lets a cross-cutting advisory agent
// be held by two different dispatchers at once while a state-owning agent still
// cannot be doubled under one dispatcher.

// --- Registry counting ---

// TestCountLiveByNameUnderParent_ScopesToNameAndParent pins the population the
// cap bounds. A count that ignored the parent would make a singleton mean "one
// per session", which would break the legitimate case of two leads each
// consulting the same advisor concurrently.
func TestCountLiveByNameUnderParent_ScopesToNameAndParent(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	// Two dispatches of the same advisor, under two DIFFERENT parents.
	r.RegisterWithID("d-adv-1", "moonshot", func() {}, child, "s", "parent-a", 2)
	r.RegisterWithID("d-adv-2", "moonshot", func() {}, child, "s", "parent-b", 2)
	// A second dispatch of a different agent under parent-a.
	r.RegisterWithID("d-other", "code-engineer", func() {}, child, "s", "parent-a", 2)

	if got := r.CountLiveByNameUnderParent("moonshot", "parent-a"); got != 1 {
		t.Errorf("count(moonshot, parent-a) = %d, want 1", got)
	}
	if got := r.CountLiveByNameUnderParent("moonshot", "parent-b"); got != 1 {
		t.Errorf("count(moonshot, parent-b) = %d, want 1", got)
	}
	if got := r.CountLiveByNameUnderParent("moonshot", "parent-c"); got != 0 {
		t.Errorf("count(moonshot, parent-c) = %d, want 0", got)
	}
	if got := r.CountLiveByNameUnderParent("code-engineer", "parent-a"); got != 1 {
		t.Errorf("count(code-engineer, parent-a) = %d, want 1", got)
	}
}

// TestCountLiveByNameUnderParent_CountsOrchestratorParent pins that the
// orchestrator's empty parent id is a real scope rather than a wildcard. Chiefs
// and staff are dispatched only by the orchestrator, so their singleton lives
// entirely in this bucket.
func TestCountLiveByNameUnderParent_CountsOrchestratorParent(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("d-lead", "dev-lead", func() {}, child, "s", "", 1)
	r.RegisterWithID("d-nested", "dev-lead", func() {}, child, "s", "some-parent", 2)

	if got := r.CountLiveByNameUnderParent("dev-lead", ""); got != 1 {
		t.Errorf("count under orchestrator = %d, want 1 (must not include the nested one)", got)
	}
}

// TestCountLiveByNameUnderParent_CountsReservations is the race guard. A
// reservation exists precisely because a dispatch is starting but not yet fully
// registered; if reservations were skipped, a burst of concurrent dispatch calls
// would each observe zero and all proceed, which is exactly what a cap of 1 must
// prevent.
func TestCountLiveByNameUnderParent_CountsReservations(t *testing.T) {
	r := NewDispatchRegistry()
	r.Reserve("d-reserved", "career-manager", "", 1)

	if got := r.CountLiveByNameUnderParent("career-manager", ""); got != 1 {
		t.Fatalf("reserved placeholder not counted: got %d, want 1", got)
	}
}

// TestCountLiveByNameUnderParent_IsCaseInsensitive pins that a cap cannot be
// bypassed by addressing the same agent with different casing.
func TestCountLiveByNameUnderParent_IsCaseInsensitive(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	r.RegisterWithID("d-1", "Dev-Lead", func() {}, child, "s", "", 1)

	if got := r.CountLiveByNameUnderParent("dev-lead", ""); got != 1 {
		t.Errorf("case-insensitive count = %d, want 1", got)
	}
}

// TestCountLiveByNameUnderParent_DropsOnDeregister pins that a finished
// dispatch frees its slot. A count that leaked would wedge a singleton agent
// permanently after its first run.
func TestCountLiveByNameUnderParent_DropsOnDeregister(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	r.RegisterWithID("d-1", "secret-service", func() {}, child, "s", "", 1)

	if got := r.CountLiveByNameUnderParent("secret-service", ""); got != 1 {
		t.Fatalf("pre-deregister count = %d, want 1", got)
	}
	r.Deregister("d-1")
	if got := r.CountLiveByNameUnderParent("secret-service", ""); got != 0 {
		t.Errorf("post-deregister count = %d, want 0; the slot must free when the dispatch ends", got)
	}
}

// TestLiveIDsByNameUnderParent_NamesTheHolders pins that a refusal can name
// WHICH dispatch holds the slot. "Already running" with no id leaves the
// dispatcher unable to wait for, steer, or read the result of the run that
// blocked it.
func TestLiveIDsByNameUnderParent_NamesTheHolders(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	r.RegisterWithID("d-bbb", "press-secretary", func() {}, child, "s", "", 1)
	r.RegisterWithID("d-aaa", "press-secretary", func() {}, child, "s", "", 1)

	got := r.LiveIDsByNameUnderParent("press-secretary", "")
	if len(got) != 2 {
		t.Fatalf("holders = %v, want 2 entries", got)
	}
	// Sorted, so a refusal message is stable rather than map-order dependent.
	if got[0] != "d-aaa" || got[1] != "d-bbb" {
		t.Errorf("holders = %v, want deterministic sorted order [d-aaa d-bbb]", got)
	}
}

// --- Guard behavior ---

// TestCheckConcurrencyCap_NoCapMeansUnlimited pins the unopinionated default: a
// harness that declares nothing keeps the historic unlimited behaviour.
func TestCheckConcurrencyCap_NoCapMeansUnlimited(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	for _, id := range []string{"d1", "d2", "d3"} {
		r.RegisterWithID(id, "code-engineer", func() {}, child, "s", "lead-1", 2)
	}
	sa := &bumpCountingAccessor{}

	for _, limit := range []int{0, -1} {
		if err := checkConcurrencyCap(sa, r, "lead-1", "code-engineer", limit); err != nil {
			t.Errorf("limit %d must mean no cap, got %v", limit, err)
		}
	}
}

// TestCheckConcurrencyCap_AllowsUpToTheLimit pins that the cap is a ceiling,
// not an off switch: a lead with a cap of 3 may hold three specialists.
func TestCheckConcurrencyCap_AllowsUpToTheLimit(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	sa := &bumpCountingAccessor{}

	r.RegisterWithID("d1", "code-engineer", func() {}, child, "s", "lead-1", 2)
	r.RegisterWithID("d2", "code-engineer", func() {}, child, "s", "lead-1", 2)

	if err := checkConcurrencyCap(sa, r, "lead-1", "code-engineer", 3); err != nil {
		t.Errorf("2 live under a cap of 3 must be allowed, got %v", err)
	}
	r.RegisterWithID("d3", "code-engineer", func() {}, child, "s", "lead-1", 2)
	if err := checkConcurrencyCap(sa, r, "lead-1", "code-engineer", 3); err == nil {
		t.Error("3 live under a cap of 3 must be refused")
	}
}

// TestCheckConcurrencyCap_SingletonRefusesSecondUnderSameParent is the core
// singleton case: a state-owning agent may not be doubled under one dispatcher.
func TestCheckConcurrencyCap_SingletonRefusesSecondUnderSameParent(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	sa := &bumpCountingAccessor{}

	r.RegisterWithID("d1", "career-manager", func() {}, child, "s", "", 1)

	err := checkConcurrencyCap(sa, r, "", "career-manager", 1)
	if err == nil {
		t.Fatal("a second dispatch of a singleton agent must be refused")
	}
	if !errors.Is(err, ErrConcurrencyCapReached) {
		t.Errorf("error = %v, want ErrConcurrencyCapReached (a distinct, retryable condition)", err)
	}
	// The refusal must name the holder so the dispatcher can act on it.
	if !strings.Contains(err.Error(), "d1") {
		t.Errorf("refusal %q does not name the dispatch holding the slot", err.Error())
	}
}

// TestCheckConcurrencyCap_SingletonAllowsOnePerParent is the consultant case
// from the operator's rule: two different leads may each hold their own
// dispatch of the same advisory agent at the same time.
func TestCheckConcurrencyCap_SingletonAllowsOnePerParent(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}
	sa := &bumpCountingAccessor{}

	// dev-lead already holds one moonshot dispatch.
	r.RegisterWithID("d-dev-moonshot", "moonshot", func() {}, child, "s", "dev-lead-1", 2)

	// The reliability engineer asking for its own moonshot must be allowed.
	if err := checkConcurrencyCap(sa, r, "reliability-1", "moonshot", 1); err != nil {
		t.Errorf("a second parent must be able to hold its own dispatch: %v", err)
	}
	// But dev-lead asking for a second one must not.
	if err := checkConcurrencyCap(sa, r, "dev-lead-1", "moonshot", 1); err == nil {
		t.Error("the same parent must not hold two dispatches of a capped agent")
	}
}

// TestCheckConcurrencyCap_NilRegistryIsInert pins the degraded path: no
// registry means no count is possible, and the guard must not block a
// legitimate dispatch on missing infrastructure.
func TestCheckConcurrencyCap_NilRegistryIsInert(t *testing.T) {
	if err := checkConcurrencyCap(&bumpCountingAccessor{}, nil, "", "any", 1); err != nil {
		t.Errorf("nil registry must be inert, got %v", err)
	}
}

// --- End-to-end through the dispatch path ---

// TestDispatchAgent_RefusesBeyondMaxConcurrentPerName pins the cap at its real
// call site and, critically, that a refusal leaves NO registry residue. A
// refusal that reserved an id would leak the slot it just refused, wedging the
// agent permanently.
func TestDispatchAgent_RefusesBeyondMaxConcurrentPerName(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child}
	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")

	// Occupy the single slot with a live dispatch under the orchestrator.
	live := &mockSteerableBackend{result: backend.SteerResultDelivered}
	registry.RegisterWithID("d-held", "career-manager", func() {}, live, "s", "", 1)

	before := registry.Count()
	_, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion:    true,
		Name:                 "career-manager",
		Task:                 "second analysis",
		MaxConcurrentPerName: 1,
	})
	if err == nil {
		t.Fatal("dispatch beyond the cap must return an error")
	}
	if !errors.Is(err, ErrConcurrencyCapReached) {
		t.Errorf("error = %v, want ErrConcurrencyCapReached", err)
	}
	if after := registry.Count(); after != before {
		t.Errorf("registry grew from %d to %d on a refused dispatch; a refusal must leave no reservation behind", before, after)
	}
}

// TestDispatchAgent_AllowsParallelWhenUncapped pins that the default path is
// unchanged: an agent with no declared cap still parallelises freely, which is
// what specialists rely on.
func TestDispatchAgent_AllowsParallelWhenUncapped(t *testing.T) {
	registry := NewDispatchRegistry()
	child := &configCapturingChildBackend{}
	accessor := &bumpCountingAccessor{child: child}
	dispatch := BuildDispatchAgentFunc(accessor, registry, 0, "")

	live := &mockSteerableBackend{result: backend.SteerResultDelivered}
	registry.RegisterWithID("d-held", "code-engineer", func() {}, live, "s", "", 1)

	if _, err := dispatch(extension.DispatchAgentOpts{
		WaitForCompletion: true,
		Name:              "code-engineer",
		Task:              "parallel work",
	}); err != nil {
		t.Fatalf("an uncapped agent must still dispatch in parallel: %v", err)
	}
}
