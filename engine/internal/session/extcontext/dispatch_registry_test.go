package extcontext

import (
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
)

// TestDispatchRegistry_RegisterDeregisterLifecycle verifies the basic
// register → count → deregister → count flow. After registering one
// dispatch the count should be 1; after deregistering, 0.
func TestDispatchRegistry_RegisterDeregisterLifecycle(t *testing.T) {
	r := NewDispatchRegistry()

	if got := r.Count(); got != 0 {
		t.Fatalf("Count on fresh registry = %d, want 0", got)
	}

	r.Register("agent-a", func() {}, nil, "sess-1")
	if got := r.Count(); got != 1 {
		t.Fatalf("Count after Register = %d, want 1", got)
	}

	r.Deregister("agent-a")
	if got := r.Count(); got != 0 {
		t.Fatalf("Count after Deregister = %d, want 0", got)
	}

	// Deregister of a nonexistent name is a safe no-op.
	r.Deregister("no-such-agent")
	if got := r.Count(); got != 0 {
		t.Fatalf("Count after no-op Deregister = %d, want 0", got)
	}
}

// TestDispatchRegistry_Get verifies that Get returns the dispatch when
// present and (nil, false) after it has been deregistered.
func TestDispatchRegistry_Get(t *testing.T) {
	r := NewDispatchRegistry()

	r.Register("agent-b", func() {}, nil, "sess-2")

	d, ok := r.Get("agent-b")
	if !ok {
		t.Fatal("Get(agent-b) returned false, want true")
	}
	if d == nil {
		t.Fatal("Get(agent-b) returned nil dispatch")
	}
	if d.Name != "agent-b" {
		t.Errorf("dispatch.Name = %q, want %q", d.Name, "agent-b")
	}
	if d.SessionID != "sess-2" {
		t.Errorf("dispatch.SessionID = %q, want %q", d.SessionID, "sess-2")
	}

	r.Deregister("agent-b")

	d2, ok2 := r.Get("agent-b")
	if ok2 {
		t.Error("Get(agent-b) after Deregister returned true, want false")
	}
	if d2 != nil {
		t.Error("Get(agent-b) after Deregister returned non-nil dispatch")
	}
}

// TestDispatchRegistry_Recall verifies that Recall invokes the cancel
// function, removes the entry, and returns true. Recalling a nonexistent
// name returns false without panicking.
func TestDispatchRegistry_Recall(t *testing.T) {
	r := NewDispatchRegistry()

	var cancelled atomic.Int32
	r.Register("agent-c", func() { cancelled.Add(1) }, nil, "sess-3")

	ok := r.Recall("agent-c", "test_reason")
	if !ok {
		t.Fatal("Recall returned false, want true")
	}
	if cancelled.Load() != 1 {
		t.Errorf("cancel called %d times, want 1", cancelled.Load())
	}
	if r.Count() != 0 {
		t.Errorf("Count after Recall = %d, want 0", r.Count())
	}

	// Recalling the same name again returns false (already removed).
	ok2 := r.Recall("agent-c", "duplicate")
	if ok2 {
		t.Error("second Recall returned true, want false")
	}

	// Recalling a name that was never registered returns false.
	ok3 := r.Recall("nonexistent", "test")
	if ok3 {
		t.Error("Recall(nonexistent) returned true, want false")
	}
}

// TestDispatchRegistry_RecallAll verifies that RecallAll cancels every
// active dispatch, clears the registry, and returns the correct count.
func TestDispatchRegistry_RecallAll(t *testing.T) {
	r := NewDispatchRegistry()

	var cancelledA, cancelledB, cancelledC atomic.Int32
	r.Register("agent-x", func() { cancelledA.Add(1) }, nil, "sess-a")
	r.Register("agent-y", func() { cancelledB.Add(1) }, nil, "sess-b")
	r.Register("agent-z", func() { cancelledC.Add(1) }, nil, "sess-c")

	if r.Count() != 3 {
		t.Fatalf("Count before RecallAll = %d, want 3", r.Count())
	}

	n := r.RecallAll("shutdown")
	if n != 3 {
		t.Errorf("RecallAll returned %d, want 3", n)
	}
	if cancelledA.Load() != 1 {
		t.Errorf("agent-x cancel called %d times, want 1", cancelledA.Load())
	}
	if cancelledB.Load() != 1 {
		t.Errorf("agent-y cancel called %d times, want 1", cancelledB.Load())
	}
	if cancelledC.Load() != 1 {
		t.Errorf("agent-z cancel called %d times, want 1", cancelledC.Load())
	}
	if r.Count() != 0 {
		t.Errorf("Count after RecallAll = %d, want 0", r.Count())
	}

	// RecallAll on an already-empty registry returns 0.
	n2 := r.RecallAll("noop")
	if n2 != 0 {
		t.Errorf("RecallAll on empty registry returned %d, want 0", n2)
	}
}

// TestDispatchRegistry_OverwriteWarning verifies that registering a
// dispatch with the same name as an existing one silently overwrites it
// (no panic) and the new cancel function is the one invoked on Recall.
func TestDispatchRegistry_OverwriteWarning(t *testing.T) {
	r := NewDispatchRegistry()

	var firstCancelled, secondCancelled atomic.Int32
	r.Register("dup", func() { firstCancelled.Add(1) }, nil, "sess-1")
	r.Register("dup", func() { secondCancelled.Add(1) }, nil, "sess-2")

	// Count should still be 1 — overwrite, not append.
	if r.Count() != 1 {
		t.Fatalf("Count after overwrite = %d, want 1", r.Count())
	}

	// The stored dispatch should reflect the second registration.
	d, ok := r.Get("dup")
	if !ok {
		t.Fatal("Get(dup) returned false after overwrite")
	}
	if d.SessionID != "sess-2" {
		t.Errorf("dispatch.SessionID = %q, want %q (second registration)", d.SessionID, "sess-2")
	}

	// Recall should invoke the second cancel function, not the first.
	r.Recall("dup", "overwrite-test")
	if secondCancelled.Load() != 1 {
		t.Errorf("second cancel called %d times, want 1", secondCancelled.Load())
	}
	if firstCancelled.Load() != 0 {
		t.Errorf("first cancel called %d times, want 0 (should not be invoked)", firstCancelled.Load())
	}
}

// TestDispatchRegistry_ConcurrentAccess exercises the registry from
// multiple goroutines to verify the mutex protects against data races.
// Run with -race to validate.
func TestDispatchRegistry_ConcurrentAccess(t *testing.T) {
	r := NewDispatchRegistry()
	const n = 50

	var wg sync.WaitGroup
	wg.Add(n * 3) // register, get, deregister

	for i := 0; i < n; i++ {
		name := "agent-" + string(rune('A'+i%26))
		go func() {
			defer wg.Done()
			r.Register(name, func() {}, nil, "sess")
		}()
		go func() {
			defer wg.Done()
			r.Get(name)
		}()
		go func() {
			defer wg.Done()
			r.Deregister(name)
		}()
	}

	wg.Wait()

	// Final cleanup — should not panic regardless of interleaving.
	r.RecallAll("teardown")
}

// TestDispatchRegistry_ActiveNames verifies that ActiveNames returns the
// correct set of currently-active dispatch names. Used by handleRunExit
// to decide which running agent states to preserve.
func TestDispatchRegistry_ActiveNames(t *testing.T) {
	r := NewDispatchRegistry()

	// Empty registry returns empty map.
	names := r.ActiveNames()
	if len(names) != 0 {
		t.Fatalf("ActiveNames on empty registry = %v, want empty", names)
	}

	// Register two dispatches.
	r.Register("agent-x", func() {}, nil, "sess-1")
	r.Register("agent-y", func() {}, nil, "sess-1")

	names = r.ActiveNames()
	if len(names) != 2 {
		t.Fatalf("ActiveNames after 2 registers = %d, want 2", len(names))
	}
	if !names["agent-x"] || !names["agent-y"] {
		t.Errorf("ActiveNames missing expected entries: %v", names)
	}

	// Deregister one — ActiveNames should reflect the removal.
	r.Deregister("agent-x")
	names = r.ActiveNames()
	if len(names) != 1 {
		t.Fatalf("ActiveNames after deregister = %d, want 1", len(names))
	}
	if !names["agent-y"] {
		t.Errorf("ActiveNames should contain agent-y, got %v", names)
	}
	if names["agent-x"] {
		t.Error("ActiveNames should not contain deregistered agent-x")
	}
}

// --- Parallel-safe dispatch registry tests ---

// TestDispatchRegistry_ParallelSameNameKeepsBoth verifies that two
// dispatches with the same agent name but different IDs both remain in
// the registry simultaneously. This is the core parallel-safety property.
//
// Revert-red: reverting to bare-name keying (Register overwrites by name)
// causes Count() to be 1 instead of 2.
func TestDispatchRegistry_ParallelSameNameKeepsBoth(t *testing.T) {
	r := NewDispatchRegistry()

	var cancelledA, cancelledB atomic.Int32
	r.RegisterWithID("dispatch-agent-1-aaa", "agent", func() { cancelledA.Add(1) }, nil, "sess-1", "", 0)
	r.RegisterWithID("dispatch-agent-1-bbb", "agent", func() { cancelledB.Add(1) }, nil, "sess-1", "", 0)

	if got := r.Count(); got != 2 {
		t.Fatalf("Count after two same-name registers = %d, want 2", got)
	}

	// ActiveNames returns one entry (both share the name "agent").
	names := r.ActiveNames()
	if len(names) != 1 {
		t.Errorf("ActiveNames = %d, want 1 (two dispatches share one name)", len(names))
	}
	if !names["agent"] {
		t.Errorf("ActiveNames missing 'agent': %v", names)
	}
}

// TestDispatchRegistry_RecallByID_TargetsSpecificInstance verifies that
// RecallByID cancels exactly one dispatch, leaving other dispatches of
// the same name alive.
//
// Revert-red: without id-based keying, RecallByID does not exist or
// does not distinguish between same-name dispatches.
func TestDispatchRegistry_RecallByID_TargetsSpecificInstance(t *testing.T) {
	r := NewDispatchRegistry()

	var cancelledA, cancelledB atomic.Int32
	r.RegisterWithID("dispatch-agent-1-aaa", "agent", func() { cancelledA.Add(1) }, nil, "sess-1", "", 0)
	r.RegisterWithID("dispatch-agent-1-bbb", "agent", func() { cancelledB.Add(1) }, nil, "sess-1", "", 0)

	// Recall only the first instance by ID.
	ok := r.RecallByID("dispatch-agent-1-aaa", "test_targeted_recall")
	if !ok {
		t.Fatal("RecallByID returned false, want true")
	}

	if cancelledA.Load() != 1 {
		t.Errorf("cancelA called %d times, want 1", cancelledA.Load())
	}
	if cancelledB.Load() != 0 {
		t.Errorf("cancelB called %d times, want 0 (should NOT be cancelled)", cancelledB.Load())
	}

	// Only one dispatch remains.
	if got := r.Count(); got != 1 {
		t.Fatalf("Count after targeted recall = %d, want 1", got)
	}

	// The surviving dispatch is retrievable.
	d, ok := r.Get("dispatch-agent-1-bbb")
	if !ok {
		t.Fatal("Get(bbb) returned false after targeted recall of aaa")
	}
	if d.Name != "agent" {
		t.Errorf("surviving dispatch Name = %q, want 'agent'", d.Name)
	}

	// RecallByID on the already-recalled dispatch returns false.
	ok2 := r.RecallByID("dispatch-agent-1-aaa", "duplicate")
	if ok2 {
		t.Error("second RecallByID returned true, want false")
	}
}

// TestDispatchRegistry_RecallByName_CancelsOneOfMany verifies that
// Recall(name) cancels one dispatch matching the name when multiple
// same-name dispatches exist.
func TestDispatchRegistry_RecallByName_CancelsOneOfMany(t *testing.T) {
	r := NewDispatchRegistry()

	var cancelled atomic.Int32
	r.RegisterWithID("id-1", "agent", func() { cancelled.Add(1) }, nil, "sess-1", "", 0)
	r.RegisterWithID("id-2", "agent", func() { cancelled.Add(1) }, nil, "sess-1", "", 0)

	ok := r.Recall("agent", "test_name_recall")
	if !ok {
		t.Fatal("Recall(name) returned false, want true")
	}

	if cancelled.Load() != 1 {
		t.Errorf("cancel called %d times, want 1 (only one of two same-name)", cancelled.Load())
	}
	if got := r.Count(); got != 1 {
		t.Fatalf("Count after name-based recall = %d, want 1", got)
	}
}

// TestDispatchRegistry_DeregisterByID verifies Deregister uses the ID key,
// not the agent name.
func TestDispatchRegistry_DeregisterByID(t *testing.T) {
	r := NewDispatchRegistry()

	r.RegisterWithID("id-x", "agent", func() {}, nil, "sess-1", "", 0)
	r.RegisterWithID("id-y", "agent", func() {}, nil, "sess-1", "", 0)

	r.Deregister("id-x")
	if got := r.Count(); got != 1 {
		t.Fatalf("Count after Deregister(id-x) = %d, want 1", got)
	}

	// id-y is still present.
	_, ok := r.Get("id-y")
	if !ok {
		t.Error("Get(id-y) returned false after Deregister(id-x)")
	}

	// Deregistering by name does nothing (key is id, not name).
	r.Deregister("agent")
	if got := r.Count(); got != 1 {
		t.Fatalf("Count after Deregister(agent) = %d, want 1 (name is not the key)", got)
	}
}

// TestDispatchRegistry_BackwardCompat_RegisterUsesNameAsID verifies that
// the legacy Register(name, ...) uses the name as both ID and name, so
// existing callers that do not produce dispatch IDs still work.
func TestDispatchRegistry_BackwardCompat_RegisterUsesNameAsID(t *testing.T) {
	r := NewDispatchRegistry()

	r.Register("agent-old", func() {}, nil, "sess-1")

	d, ok := r.Get("agent-old")
	if !ok {
		t.Fatal("Get(agent-old) returned false")
	}
	if d.Name != "agent-old" {
		t.Errorf("Name = %q, want 'agent-old'", d.Name)
	}
	if d.ID != "agent-old" {
		t.Errorf("ID = %q, want 'agent-old' (backward compat)", d.ID)
	}
}

// --- SteerByID tests ---

// mockSteerableBackend is a fake backend that implements Steerable for
// testing SteerByID. It records the last steer call and returns a
// configurable SteerResult.
type mockSteerableBackend struct {
	backend.RunBackend
	result      backend.SteerResult
	lastRunID   string
	lastMessage string
	called      bool
}

func (m *mockSteerableBackend) SteerWithReason(requestID, message string) backend.SteerResult {
	m.called = true
	m.lastRunID = requestID
	m.lastMessage = message
	return m.result
}

// TestDispatchRegistry_SteerByID_Delivered verifies that SteerByID
// returns SteerOutcomeDelivered when the child backend accepts the steer.
func TestDispatchRegistry_SteerByID_Delivered(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultDelivered}

	r.RegisterWithID("dispatch-abc", "agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-abc", "sess-1-dispatch-abc")

	outcome := r.SteerByID("dispatch-abc", "redirect to tests")

	if outcome != SteerOutcomeDelivered {
		t.Fatalf("SteerByID outcome = %q, want %q", outcome, SteerOutcomeDelivered)
	}
	if !child.called {
		t.Fatal("child.SteerWithReason was not called")
	}
	if child.lastRunID != "sess-1-dispatch-abc" {
		t.Errorf("child received runID = %q, want %q", child.lastRunID, "sess-1-dispatch-abc")
	}
	if child.lastMessage != "redirect to tests" {
		t.Errorf("child received message = %q, want %q", child.lastMessage, "redirect to tests")
	}
}

// TestDispatchRegistry_SteerByID_ChannelFull verifies SteerOutcomeChannelFull.
func TestDispatchRegistry_SteerByID_ChannelFull(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultChannelFull}

	r.RegisterWithID("dispatch-xyz", "agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-xyz", "run-xyz")

	outcome := r.SteerByID("dispatch-xyz", "overflow")

	if outcome != SteerOutcomeChannelFull {
		t.Fatalf("SteerByID outcome = %q, want %q", outcome, SteerOutcomeChannelFull)
	}
}

// TestDispatchRegistry_SteerByID_NoRun verifies SteerOutcomeNoRun when the
// child backend has no active run for the ChildRunID.
func TestDispatchRegistry_SteerByID_NoRun(t *testing.T) {
	r := NewDispatchRegistry()
	child := &mockSteerableBackend{result: backend.SteerResultNoRun}

	r.RegisterWithID("dispatch-nnn", "agent", func() {}, child, "sess-1", "", 0)
	r.SetChildRunID("dispatch-nnn", "run-gone")

	outcome := r.SteerByID("dispatch-nnn", "hello")

	if outcome != SteerOutcomeNoRun {
		t.Fatalf("SteerByID outcome = %q, want %q", outcome, SteerOutcomeNoRun)
	}
}

// TestDispatchRegistry_SteerByID_NotFound verifies SteerOutcomeNotFound
// when no dispatch with the given ID exists in the registry.
func TestDispatchRegistry_SteerByID_NotFound(t *testing.T) {
	r := NewDispatchRegistry()

	outcome := r.SteerByID("no-such-dispatch", "hello")

	if outcome != SteerOutcomeNotFound {
		t.Fatalf("SteerByID outcome = %q, want %q", outcome, SteerOutcomeNotFound)
	}
}

// TestDispatchRegistry_SetChildRunID verifies that SetChildRunID updates the
// ChildRunID on an existing entry and is a no-op for nonexistent entries.
func TestDispatchRegistry_SetChildRunID(t *testing.T) {
	r := NewDispatchRegistry()

	// No-op for nonexistent entry (no panic).
	r.SetChildRunID("nonexistent", "run-1")

	r.RegisterWithID("dispatch-set", "agent", func() {}, nil, "sess-1", "", 0)

	d, ok := r.Get("dispatch-set")
	if !ok {
		t.Fatal("Get returned false after register")
	}
	if d.ChildRunID != "" {
		t.Errorf("ChildRunID before SetChildRunID = %q, want empty", d.ChildRunID)
	}

	r.SetChildRunID("dispatch-set", "the-run-id")
	d2, _ := r.Get("dispatch-set")
	if d2.ChildRunID != "the-run-id" {
		t.Errorf("ChildRunID after SetChildRunID = %q, want %q", d2.ChildRunID, "the-run-id")
	}
}
