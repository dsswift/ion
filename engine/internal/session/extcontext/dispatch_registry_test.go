package extcontext

import (
	"sync"
	"sync/atomic"
	"testing"
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
