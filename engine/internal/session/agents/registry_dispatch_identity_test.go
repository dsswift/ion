package agents

// registry_dispatch_identity_test.go — tests that groupByName preserves the
// per-dispatch identity (dispatchId) of same-name dispatches in the emitted
// engine_agent_state snapshot, so concurrent same-name dispatches remain
// distinct, ID-addressable entries rather than collapsing anonymously.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestGroupByNameDistinctDispatches creates two concurrent dispatches with the
// same agent name but distinct dispatch ids and distinct parent ids, drives
// them through the snapshot/groupByName projection, and asserts each dispatch
// remains distinct and ID-addressable with a non-empty dispatchId.
//
// This test previously asserted the two collapsed into ONE row, with per-
// dispatch identity preserved only inside metadata.dispatches[]. That shape was
// the defect: the single row carried a single top-level dispatchParentId, and a
// consumer grouping children by that field (the desktop's childAgentsOf) could
// match only one parent -- every other parent's drill-down showed no children.
//
// Observed live: two "poll-check" dispatches under different parents produced
// one emitted row whose parent flipped mid-run as statusPriority changed
// (running=4 beat error=2). The child never vanished; the collapsed row stopped
// pointing at the parent being viewed.
//
// Grouping is now keyed by name AND parent, so distinct lineages stay distinct
// rows. The per-member identity stamping this test also covers is unchanged and
// still asserted below -- same name under the SAME parent still collapses, which
// is the duplicate-row case the projection exists to prevent.
func TestGroupByNameDistinctDispatches(t *testing.T) {
	r := NewRegistry()

	// Dispatch A: same name "dev-lead", id "d1", parent "root", depth 1.
	r.AppendOrUpdateByID(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "d1",
		Status: "running",
		Metadata: map[string]interface{}{
			"task":             "first branch",
			"dispatchDepth":    1,
			"dispatchParentId": "root",
			"dispatches": []interface{}{
				map[string]interface{}{
					"id":               "d1",
					"status":           "running",
					"dispatchDepth":    1,
					"dispatchParentId": "root",
				},
			},
		},
	}, func(existing *types.AgentStateUpdate) {})

	// Dispatch B: same name "dev-lead", distinct id "d2", distinct parent
	// "orchestrator", depth 2 — genuinely concurrent, distinct lineage.
	r.AppendOrUpdateByID(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "d2",
		Status: "running",
		Metadata: map[string]interface{}{
			"task":             "second branch",
			"dispatchDepth":    2,
			"dispatchParentId": "orchestrator",
			"dispatches": []interface{}{
				map[string]interface{}{
					"id":               "d2",
					"status":           "running",
					"dispatchDepth":    2,
					"dispatchParentId": "orchestrator",
				},
			},
		},
	}, func(existing *types.AgentStateUpdate) {})

	snap := r.MergedSnapshot()
	// Distinct parents => distinct rows. One row per lineage is what lets a
	// consumer group children by the top-level dispatchParentId.
	if len(snap) != 2 {
		t.Fatalf("expected 2 dev-lead rows (one per parent lineage), got %d: %+v", len(snap), snap)
	}

	byParent := map[string]types.AgentStateUpdate{}
	for _, row := range snap {
		parent, _ := row.Metadata["dispatchParentId"].(string)
		if _, dup := byParent[parent]; dup {
			t.Fatalf("two rows share parent %q — lineages collapsed", parent)
		}
		byParent[parent] = row
	}
	if _, ok := byParent["root"]; !ok {
		t.Fatalf("no row attributed to parent root: %+v", snap)
	}
	if _, ok := byParent["orchestrator"]; !ok {
		t.Fatalf("no row attributed to parent orchestrator: %+v", snap)
	}

	// Per-member identity stamping is unchanged: gather every member across
	// both rows and assert each is ID-addressable.
	var dispatches []interface{}
	for _, row := range snap {
		if d, ok := row.Metadata["dispatches"].([]interface{}); ok {
			dispatches = append(dispatches, d...)
		}
	}
	if len(dispatches) != 2 {
		t.Fatalf("expected 2 distinct dispatch members, got %d: %v", len(dispatches), dispatches)
	}

	// Index members by their dispatchId to prove each is ID-addressable and
	// that neither dispatchId is empty.
	byDispatchID := make(map[string]map[string]interface{})
	for i, entry := range dispatches {
		m, ok := entry.(map[string]interface{})
		if !ok {
			t.Fatalf("dispatch member %d is not a map: %T", i, entry)
		}
		did, _ := m["dispatchId"].(string)
		if did == "" {
			t.Errorf("dispatch member %d has empty dispatchId: %v", i, m)
			continue
		}
		if _, dup := byDispatchID[did]; dup {
			t.Errorf("duplicate dispatchId %q — members are not distinct", did)
		}
		byDispatchID[did] = m
	}

	// Both distinct dispatches must be present and addressable by id.
	d1, ok1 := byDispatchID["d1"]
	if !ok1 {
		t.Fatalf("dispatch d1 not addressable in snapshot: %v", byDispatchID)
	}
	d2, ok2 := byDispatchID["d2"]
	if !ok2 {
		t.Fatalf("dispatch d2 not addressable in snapshot: %v", byDispatchID)
	}

	// Each member retains its own distinct parent lineage — the whole point of
	// preserving per-dispatch identity.
	if p, _ := d1["dispatchParentId"].(string); p != "root" {
		t.Errorf("d1 dispatchParentId = %q, want root", p)
	}
	if p, _ := d2["dispatchParentId"].(string); p != "orchestrator" {
		t.Errorf("d2 dispatchParentId = %q, want orchestrator", p)
	}

	// Existing "id" key is preserved (additive change — nothing removed).
	if id, _ := d1["id"].(string); id != "d1" {
		t.Errorf("d1 lost its stable id: got %q", id)
	}
	if id, _ := d2["id"].(string); id != "d2" {
		t.Errorf("d2 lost its stable id: got %q", id)
	}
}
