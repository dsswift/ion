package agents

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// Regression test for same-name dispatches under different parents collapsing
// into a single emitted row.
//
// groupByName keyed on agent name alone, so every dispatch sharing a name --
// across all parents and depths -- became one representative row bearing one
// top-level dispatchParentId. A consumer grouping children by that field (the
// desktop's childAgentsOf) could therefore match only ONE parent: every other
// parent's drill-down showed no children at all.
//
// Observed live: two "poll-check" dispatches under different parents produced a
// single emitted row whose parent flipped mid-run as statusPriority changed
// (running=4 beat error=2). At 18:36:43 the row pointed at the active dispatch;
// at 18:36:44 a stale run's row won the slot and the parent changed. The child
// never disappeared -- the collapsed row stopped pointing at the parent being
// viewed.
//
// Reverting groupByName's key to s.Name alone turns these red.

func pollCheckRow(id, parentID, status string) types.AgentStateUpdate {
	return types.AgentStateUpdate{
		Name:   "poll-check",
		ID:     id,
		Status: status,
		Metadata: map[string]interface{}{
			"dispatchParentId": parentID,
			"dispatchDepth":    2,
			"visibility":       "sticky",
			"invited":          true,
			"dispatches": []interface{}{
				map[string]interface{}{"id": id, "status": status, "dispatchParentId": parentID},
			},
		},
	}
}

// Each parent must keep its own row, so each parent's drill-down can find its
// own child.
func TestSameNameDispatchesUnderDifferentParentsStayDistinct(t *testing.T) {
	r := NewRegistry()
	noop := func(*types.AgentStateUpdate) {}
	r.AppendOrUpdateByID(pollCheckRow("pc-1", "dispatch-agent-1", "running"), noop)
	r.AppendOrUpdateByID(pollCheckRow("pc-2", "dispatch-agent-2", "error"), noop)

	snap := r.MergedSnapshot()

	parents := map[string]bool{}
	for _, row := range snap {
		if row.Name != "poll-check" {
			continue
		}
		parent, _ := row.Metadata["dispatchParentId"].(string)
		if parents[parent] {
			t.Fatalf("duplicate row for parent %q", parent)
		}
		parents[parent] = true
	}

	if !parents["dispatch-agent-1"] {
		t.Error("no poll-check row attributed to dispatch-agent-1: its drill-down would show no children")
	}
	if !parents["dispatch-agent-2"] {
		t.Error("no poll-check row attributed to dispatch-agent-2: its drill-down would show no children")
	}
}

// The live failure shape: a lower-priority row from a stale run must not steal
// the representative slot from an active dispatch under a different parent.
func TestStaleRowDoesNotStealAnotherParentsSlot(t *testing.T) {
	r := NewRegistry()
	noop := func(*types.AgentStateUpdate) {}
	// A finished dispatch from an earlier run, still in the roster.
	r.AppendOrUpdateByID(pollCheckRow("pc-old", "dispatch-agent-old", "error"), noop)
	// The dispatch the operator is currently looking at.
	r.AppendOrUpdateByID(pollCheckRow("pc-live", "dispatch-agent-live", "running"), noop)

	var liveFound bool
	for _, row := range r.MergedSnapshot() {
		if parent, _ := row.Metadata["dispatchParentId"].(string); parent == "dispatch-agent-live" {
			liveFound = true
		}
	}
	if !liveFound {
		t.Fatal("the live dispatch's child row was displaced by a stale run's row: the operator's open drill-down shows nothing")
	}
}

// Same name under the SAME parent still collapses. That is the duplicate-row
// case the projection exists to prevent, and this change must not undo it.
func TestSameNameUnderSameParentStillCollapses(t *testing.T) {
	r := NewRegistry()
	noop := func(*types.AgentStateUpdate) {}
	r.AppendOrUpdateByID(pollCheckRow("pc-a", "dispatch-agent-1", "running"), noop)
	r.AppendOrUpdateByID(pollCheckRow("pc-b", "dispatch-agent-1", "done"), noop)

	rows := 0
	for _, row := range r.MergedSnapshot() {
		if row.Name == "poll-check" {
			rows++
		}
	}
	if rows != 1 {
		t.Fatalf("same name under one parent produced %d rows, want 1 collapsed row", rows)
	}
}

// Root-level rows carry no parent id and must group together exactly as before.
func TestRootLevelRowsGroupTogether(t *testing.T) {
	r := NewRegistry()
	noop := func(*types.AgentStateUpdate) {}
	r.AppendOrUpdateByID(types.AgentStateUpdate{Name: "reviewer", ID: "r1", Status: "running"}, noop)
	r.AppendOrUpdateByID(types.AgentStateUpdate{Name: "reviewer", ID: "r2", Status: "done"}, noop)

	rows := 0
	for _, row := range r.MergedSnapshot() {
		if row.Name == "reviewer" {
			rows++
		}
	}
	if rows != 1 {
		t.Fatalf("unattributed same-name rows produced %d rows, want 1", rows)
	}
}
