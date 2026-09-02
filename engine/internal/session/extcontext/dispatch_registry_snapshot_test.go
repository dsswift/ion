package extcontext

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/tools"
)

func TestAgentStatusGetterMapsCompleteActiveSnapshot(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("dispatch-parent", "parent", nil, nil, "sess", "", 1)
	r.RegisterWithID("dispatch-child", "child", nil, nil, "sess", "dispatch-parent", 2)
	r.SetChildConvID("dispatch-child", "child-conversation")
	r.UpdateActivity("dispatch-child", 4, "Using Read...")
	if !r.SetSuspendedStateWithWaitingOn("dispatch-child", make(chan struct{}, 1), []string{"dispatch-grandchild"}, []string{"bash-task"}, nil) {
		t.Fatal("failed to suspend child dispatch")
	}

	entries := AgentStatusGetter(r)()
	if len(entries) != 2 {
		t.Fatalf("AgentStatusGetter entries = %d, want 2", len(entries))
	}
	var child tools.AgentStatusEntry
	for _, entry := range entries {
		if entry.DispatchID == "dispatch-child" {
			child = entry
		}
	}
	if child.DispatchID == "" {
		t.Fatal("AgentStatusGetter missing child dispatch")
	}
	if child.Status != "suspended" || child.ParentDispatchID != "dispatch-parent" || child.Depth != 2 {
		t.Fatalf("AgentStatusGetter hierarchy/status = %#v", child)
	}
	if child.ChildConversationID != "child-conversation" || child.ToolCount != 4 || child.LastWork != "Using Read..." || child.StartedAt == "" {
		t.Fatalf("AgentStatusGetter activity fields = %#v", child)
	}
	if child.WaitingOn == nil || !equalStrings(child.WaitingOn.TaskIDs, []string{"bash-task"}) || !equalStrings(child.WaitingOn.ChildDispatchIDs, []string{"dispatch-grandchild"}) {
		t.Fatalf("AgentStatusGetter waiting set = %#v", child.WaitingOn)
	}

	r.Deregister("dispatch-child")
	for _, entry := range AgentStatusGetter(r)() {
		if entry.DispatchID == "dispatch-child" {
			t.Fatal("AgentStatusGetter retained terminal dispatch after deregistration")
		}
	}
}

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

	// Park beta on mixed task and child work. Snapshot must preserve exact,
	// sorted sets so SDK consumers can distinguish what holds it open.
	if !r.SetSuspendedStateWithWaitingOn("dispatch-beta-1001-bbb", make(chan struct{}, 1), []string{"child-z", "child-a"}, []string{"bash-2", "bash-1"}, nil) {
		t.Fatal("SetSuspendedStateWithWaitingOn unexpectedly refused to park")
	}
	snap = r.Snapshot()
	for _, entry := range snap {
		if entry.DispatchID != "dispatch-beta-1001-bbb" {
			continue
		}
		if entry.Status != "suspended" {
			t.Errorf("beta.Status = %q, want suspended", entry.Status)
		}
		if entry.WaitingOn == nil {
			t.Fatal("beta.WaitingOn = nil, want task and child sets")
		}
		if got, want := entry.WaitingOn.TaskIDs, []string{"bash-1", "bash-2"}; !equalStrings(got, want) {
			t.Errorf("beta.WaitingOn.TaskIDs = %v, want %v", got, want)
		}
		if got, want := entry.WaitingOn.ChildDispatchIDs, []string{"child-a", "child-z"}; !equalStrings(got, want) {
			t.Errorf("beta.WaitingOn.ChildDispatchIDs = %v, want %v", got, want)
		}
	}

	// Completion drains only its task ID, preserving remaining task and child
	// wait metadata for the next snapshot.
	if owner, revived := r.DeliverTaskResult("bash-1", TaskResultRecord{Status: "completed"}); owner != "dispatch-beta-1001-bbb" || revived {
		t.Fatalf("DeliverTaskResult = (%q, %v), want (dispatch-beta-1001-bbb, false) — one task of a mixed wait set must not revive", owner, revived)
	}
	for _, entry := range r.Snapshot() {
		if entry.DispatchID != "dispatch-beta-1001-bbb" {
			continue
		}
		if entry.WaitingOn == nil {
			t.Fatal("beta.WaitingOn = nil after one task completion")
		}
		if got, want := entry.WaitingOn.TaskIDs, []string{"bash-2"}; !equalStrings(got, want) {
			t.Errorf("remaining TaskIDs = %v, want %v", got, want)
		}
		if got, want := entry.WaitingOn.ChildDispatchIDs, []string{"child-a", "child-z"}; !equalStrings(got, want) {
			t.Errorf("remaining ChildDispatchIDs = %v, want %v", got, want)
		}
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

// TestDispatchRegistry_Snapshot_StatusRunningForActive verifies that active,
// non-parked entries carry Status="running". Parked entries are covered above;
// terminal entries never appear because Deregister removes them.
func TestDispatchRegistry_Snapshot_StatusRunningForActive(t *testing.T) {
	r := NewDispatchRegistry()
	r.RegisterWithID("id-1", "agent", nil, nil, "sess", "", 1)
	r.RegisterWithID("id-2", "other", nil, nil, "sess", "id-1", 2)

	for _, e := range r.Snapshot() {
		if e.Status != "running" {
			t.Errorf("entry %q: Status = %q, want \"running\"", e.DispatchID, e.Status)
		}
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
