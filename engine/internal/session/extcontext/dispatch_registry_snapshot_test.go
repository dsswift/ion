package extcontext

import (
	"testing"
	"time"
)

// TestDispatchRegistry_Snapshot_ReturnsActiveEntries verifies that Snapshot
// returns a DispatchStateEntry for each registered dispatch and omits
// deregistered ones. Without the Snapshot method this test cannot compile.
func TestDispatchRegistry_Snapshot_ReturnsActiveEntries(t *testing.T) {
	r := NewDispatchRegistry()

	// Empty registry returns empty slice (not nil).
	snap := r.Snapshot()
	if snap == nil {
		t.Fatal("Snapshot: expected non-nil slice for empty registry, got nil")
	}
	if len(snap) != 0 {
		t.Fatalf("Snapshot: expected 0 entries for empty registry, got %d", len(snap))
	}

	// Register two dispatches with distinct IDs, names, parent relationships.
	r.RegisterWithID("dispatch-alpha-1000-aaa", "alpha", nil, nil, "sess", "", 1)
	r.RegisterWithID("dispatch-beta-1001-bbb", "beta", nil, nil, "sess", "dispatch-alpha-1000-aaa", 2)

	before := time.Now()
	snap = r.Snapshot()
	after := time.Now()

	if len(snap) != 2 {
		t.Fatalf("Snapshot: expected 2 entries, got %d", len(snap))
	}

	byID := make(map[string]DispatchStateEntry, 2)
	for _, e := range snap {
		byID[e.DispatchID] = e
	}

	alpha, ok := byID["dispatch-alpha-1000-aaa"]
	if !ok {
		t.Fatal("Snapshot: missing entry for dispatch-alpha-1000-aaa")
	}
	if alpha.Name != "alpha" {
		t.Errorf("alpha.Name = %q, want %q", alpha.Name, "alpha")
	}
	if alpha.Status != "running" {
		t.Errorf("alpha.Status = %q, want \"running\"", alpha.Status)
	}
	if alpha.Depth != 1 {
		t.Errorf("alpha.Depth = %d, want 1", alpha.Depth)
	}
	if alpha.ParentDispatchID != "" {
		t.Errorf("alpha.ParentDispatchID = %q, want empty (top-level)", alpha.ParentDispatchID)
	}
	if alpha.StartedAt.IsZero() {
		t.Error("alpha.StartedAt is zero")
	}
	if alpha.ElapsedMs < 0 {
		t.Errorf("alpha.ElapsedMs = %d, want >= 0", alpha.ElapsedMs)
	}

	beta, ok := byID["dispatch-beta-1001-bbb"]
	if !ok {
		t.Fatal("Snapshot: missing entry for dispatch-beta-1001-bbb")
	}
	if beta.Name != "beta" {
		t.Errorf("beta.Name = %q, want %q", beta.Name, "beta")
	}
	if beta.Depth != 2 {
		t.Errorf("beta.Depth = %d, want 2", beta.Depth)
	}
	if beta.ParentDispatchID != "dispatch-alpha-1000-aaa" {
		t.Errorf("beta.ParentDispatchID = %q, want %q", beta.ParentDispatchID, "dispatch-alpha-1000-aaa")
	}

	// ElapsedMs must be consistent with the wall-clock window around the call.
	maxElapsed := after.Sub(before).Milliseconds() + 5 // 5ms slop
	if alpha.ElapsedMs > maxElapsed {
		t.Errorf("alpha.ElapsedMs = %d, expected <= %d (snapshot window)", alpha.ElapsedMs, maxElapsed)
	}

	// Deregister one entry; snapshot must shrink to 1.
	r.Deregister("dispatch-alpha-1000-aaa")
	snap = r.Snapshot()
	if len(snap) != 1 {
		t.Fatalf("Snapshot after Deregister: expected 1 entry, got %d", len(snap))
	}
	if snap[0].DispatchID != "dispatch-beta-1001-bbb" {
		t.Errorf("Snapshot after Deregister: expected beta entry, got %q", snap[0].DispatchID)
	}
}

// TestDispatchRegistry_Snapshot_StatusAlwaysRunning verifies that every entry
// returned by Snapshot carries Status="running", regardless of how it was
// registered. The registry's deregister-on-completion invariant means no
// terminal entry ever appears, but the field must be explicitly set.
func TestDispatchRegistry_Snapshot_StatusAlwaysRunning(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("id-1", "agent", nil, nil, "sess", "", 1)
	r.RegisterWithID("id-2", "other", nil, nil, "sess", "id-1", 2)

	for _, e := range r.Snapshot() {
		if e.Status != "running" {
			t.Errorf("entry %q: Status = %q, want \"running\"", e.DispatchID, e.Status)
		}
	}
}
