package agents

import (
	"fmt"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- AppendOrUpdate basic ---

// TestRegistry_AppendOrUpdate verifies the atomic append-or-update method:
// first call appends, second call with same name updates in place, and a
// different name appends separately.
func TestRegistry_AppendOrUpdate(t *testing.T) {
	r := NewRegistry()

	// First call: no existing entry → appends, returns false.
	reused := r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "dispatch-1",
		Status: "running",
		Metadata: map[string]interface{}{
			"task": "first task",
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-1"
		existing.Status = "running"
	})

	if reused {
		t.Error("first call should return false (appended, not updated)")
	}
	snap := r.MergedSnapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry after first append, got %d", len(snap))
	}
	if snap[0].Name != "dev-lead" || snap[0].ID != "dispatch-1" {
		t.Errorf("unexpected entry: %+v", snap[0])
	}

	// Second call with same name → updates in place, returns true.
	reused = r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "dispatch-2",
		Status: "running",
		Metadata: map[string]interface{}{
			"task": "second task",
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-2"
		existing.Status = "running"
		if existing.Metadata == nil {
			existing.Metadata = map[string]interface{}{}
		}
		existing.Metadata["task"] = "second task"
	})

	if !reused {
		t.Error("second call should return true (updated existing)")
	}
	snap = r.MergedSnapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry after update (no duplicate), got %d", len(snap))
	}
	if snap[0].ID != "dispatch-2" {
		t.Errorf("expected ID dispatch-2 after update, got %s", snap[0].ID)
	}
	if snap[0].Metadata["task"] != "second task" {
		t.Errorf("expected updated task, got %v", snap[0].Metadata["task"])
	}

	// Different name → appends separately.
	reused = r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "architect",
		ID:     "dispatch-3",
		Status: "running",
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-3"
	})

	if reused {
		t.Error("different name should return false (appended)")
	}
	snap = r.MergedSnapshot()
	if len(snap) != 2 {
		t.Fatalf("expected 2 entries after different-name append, got %d", len(snap))
	}
}

// TestRegistry_AppendOrUpdate_PreservesMetadata verifies that the updater
// can selectively modify fields while preserving others (e.g. conversationIds
// from a previous dispatch).
func TestRegistry_AppendOrUpdate_PreservesMetadata(t *testing.T) {
	r := NewRegistry()

	// Initial append with rich metadata.
	r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "dispatch-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"displayName":     "Dev Lead",
			"conversationIds": []interface{}{"conv-1"},
			"task":            "first task",
		},
	}, func(existing *types.AgentStateUpdate) {})

	// Re-dispatch: updater modifies task but preserves conversationIds.
	r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "dispatch-2",
		Status: "running",
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-2"
		existing.Status = "running"
		existing.Metadata["task"] = "second task"
		existing.Metadata["lastWork"] = ""
		delete(existing.Metadata, "elapsed")
	})

	snap := r.MergedSnapshot()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(snap))
	}
	s := snap[0]
	if s.ID != "dispatch-2" {
		t.Errorf("expected dispatch-2, got %s", s.ID)
	}
	// conversationIds from first dispatch should be preserved.
	ids, ok := s.Metadata["conversationIds"].([]interface{})
	if !ok || len(ids) != 1 || ids[0] != "conv-1" {
		t.Errorf("expected preserved conversationIds, got %v", s.Metadata["conversationIds"])
	}
	// displayName should be preserved.
	if s.Metadata["displayName"] != "Dev Lead" {
		t.Errorf("expected preserved displayName, got %v", s.Metadata["displayName"])
	}
}

// --- Concurrent AppendOrUpdate ---

// TestRegistry_AppendOrUpdate_Concurrent launches N goroutines all calling
// AppendOrUpdate with the same agent name and asserts that MergedSnapshot
// contains exactly one entry with that name. This test catches the TOCTOU
// race that existed when FindStateIndex + AppendState were separate lock
// acquisitions.
func TestRegistry_AppendOrUpdate_Concurrent(t *testing.T) {
	const goroutines = 100
	r := NewRegistry()

	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			r.AppendOrUpdate(types.AgentStateUpdate{
				Name:   "dev-lead",
				ID:     fmt.Sprintf("dispatch-%d", idx),
				Status: "running",
				Metadata: map[string]interface{}{
					"task": fmt.Sprintf("task-%d", idx),
				},
			}, func(existing *types.AgentStateUpdate) {
				existing.ID = fmt.Sprintf("dispatch-%d", idx)
				existing.Status = "running"
				if existing.Metadata == nil {
					existing.Metadata = map[string]interface{}{}
				}
				existing.Metadata["task"] = fmt.Sprintf("task-%d", idx)
			})
		}(i)
	}

	wg.Wait()

	snap := r.MergedSnapshot()
	count := 0
	for _, s := range snap {
		if s.Name == "dev-lead" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 dev-lead entry, got %d (TOCTOU race produced duplicates)", count)
	}
}

// TestRegistry_AppendOrUpdate_ConcurrentDifferentNames verifies that
// concurrent AppendOrUpdate calls with different names each produce
// exactly one entry.
func TestRegistry_AppendOrUpdate_ConcurrentDifferentNames(t *testing.T) {
	const goroutines = 50
	r := NewRegistry()

	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			name := fmt.Sprintf("agent-%d", idx)
			r.AppendOrUpdate(types.AgentStateUpdate{
				Name:   name,
				ID:     fmt.Sprintf("dispatch-%d", idx),
				Status: "running",
			}, func(existing *types.AgentStateUpdate) {
				existing.ID = fmt.Sprintf("dispatch-%d", idx)
			})
		}(i)
	}

	wg.Wait()

	snap := r.MergedSnapshot()
	if len(snap) != goroutines {
		t.Errorf("expected %d entries for %d unique names, got %d", goroutines, goroutines, len(snap))
	}
}
