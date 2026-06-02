package agents

// registry_rehydrate_test.go — tests for populating a Registry from
// persisted dispatch records, verifying that MergedSnapshot produces
// correct results and that extension roster emissions do not wipe
// loaded dispatch history.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestPopulateFromDispatchRecords loads dispatch records into a fresh
// registry and verifies MergedSnapshot returns correct entries.
func TestPopulateFromDispatchRecords(t *testing.T) {
	r := NewRegistry()

	// Simulate rehydration: append persisted dispatch records.
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"displayName":    "Agent Designer",
			"task":           "brief me",
			"model":          "claude-sonnet-4-6",
			"elapsed":        32.5,
			"conversationId": "conv-abc",
			"conversationIds": []interface{}{"conv-abc"},
		},
	})

	merged := r.MergedSnapshot()
	if len(merged) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(merged))
	}

	entry := merged[0]
	if entry.Name != "agent-designer" {
		t.Errorf("Name = %q, want agent-designer", entry.Name)
	}
	if entry.Status != "done" {
		t.Errorf("Status = %q, want done", entry.Status)
	}
	if entry.Metadata["task"] != "brief me" {
		t.Errorf("task = %v, want brief me", entry.Metadata["task"])
	}
	if entry.Metadata["conversationId"] != "conv-abc" {
		t.Errorf("conversationId = %v, want conv-abc", entry.Metadata["conversationId"])
	}
	if entry.Metadata["elapsed"] != 32.5 {
		t.Errorf("elapsed = %v, want 32.5", entry.Metadata["elapsed"])
	}
}

// TestPopulateFromDispatchRecords_PlusExtensionRoster verifies that
// rehydrated dispatch entries win over extension roster entries with
// the same name via MergedSnapshot deduplication.
func TestPopulateFromDispatchRecords_PlusExtensionRoster(t *testing.T) {
	r := NewRegistry()

	// Rehydrate from disk: agent-designer at "done" with metadata.
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"displayName":    "Agent Designer",
			"task":           "brief me",
			"conversationId": "conv-abc",
		},
	})

	// Extension emits its fresh roster: agent-designer at "idle".
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "idle", Metadata: map[string]interface{}{
			"displayName": "Agent Designer",
		}},
		{Name: "hook-specialist", Status: "idle"},
	})

	merged := r.MergedSnapshot()

	// Should be 3: ion-tutor + agent-designer (engine wins) + hook-specialist.
	if len(merged) != 3 {
		t.Fatalf("expected 3 entries, got %d: %v", len(merged), names(merged))
	}

	// The engine-managed entry should win for agent-designer.
	for _, s := range merged {
		if s.Name == "agent-designer" {
			if s.Status != "done" {
				t.Errorf("agent-designer status = %q, want done (engine wins)", s.Status)
			}
			if s.Metadata["task"] != "brief me" {
				t.Errorf("agent-designer should have engine metadata, got %v", s.Metadata)
			}
			if s.Metadata["conversationId"] != "conv-abc" {
				t.Errorf("conversationId = %v, want conv-abc", s.Metadata["conversationId"])
			}
		}
	}
}

// TestPopulateFromDispatchRecords_FreshRosterDoesNotWipeHistory
// verifies that caching a fresh extension roster (all idle) does NOT
// overwrite completed dispatch entries loaded from disk.
func TestPopulateFromDispatchRecords_FreshRosterDoesNotWipeHistory(t *testing.T) {
	r := NewRegistry()

	// Rehydrate two completed dispatches.
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":           "first task",
			"conversationId": "conv-1",
		},
	})
	r.AppendState(types.AgentStateUpdate{
		Name:   "cloud-architect",
		ID:     "dispatch-ca-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":           "review architecture",
			"conversationId": "conv-2",
		},
	})

	// Extension fires session_start → emits all-idle roster.
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "idle"},
		{Name: "cloud-architect", Status: "idle"},
		{Name: "hook-specialist", Status: "idle"},
	})

	merged := r.MergedSnapshot()

	// Should have 4 entries: ion-tutor + hook-specialist (ext) +
	// agent-designer + cloud-architect (engine wins).
	if len(merged) != 4 {
		t.Fatalf("expected 4 entries, got %d: %v", len(merged), names(merged))
	}

	// Verify engine entries retained their metadata.
	for _, s := range merged {
		switch s.Name {
		case "agent-designer":
			if s.Status != "done" {
				t.Errorf("agent-designer should be done, got %s", s.Status)
			}
			if s.Metadata["conversationId"] != "conv-1" {
				t.Errorf("agent-designer convId should be conv-1, got %v", s.Metadata["conversationId"])
			}
		case "cloud-architect":
			if s.Status != "done" {
				t.Errorf("cloud-architect should be done, got %s", s.Status)
			}
			if s.Metadata["conversationId"] != "conv-2" {
				t.Errorf("cloud-architect convId should be conv-2, got %v", s.Metadata["conversationId"])
			}
		case "ion-tutor", "hook-specialist":
			if s.Status != "idle" {
				t.Errorf("%s should be idle, got %s", s.Name, s.Status)
			}
		}
	}
}

// TestPopulateFromDispatchRecords_MultipleDispatches verifies that
// multiple dispatch records for the same agent are coalesced via
// AppendOrUpdate (matching the real rehydration loop), so the
// registry contains one entry per agent name with merged metadata.
func TestPopulateFromDispatchRecords_MultipleDispatches(t *testing.T) {
	r := NewRegistry()

	// First dispatch for agent-designer — AppendOrUpdate inserts.
	dispatchEntry1 := map[string]interface{}{
		"id":             "dispatch-ad-1",
		"task":           "first task",
		"status":         "done",
		"conversationId": "conv-1",
	}
	r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":            "first task",
			"conversationId":  "conv-1",
			"conversationIds": []interface{}{"conv-1"},
			"dispatches":      []interface{}{dispatchEntry1},
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-ad-1"
		existing.Status = "done"
		if existing.Metadata == nil {
			existing.Metadata = map[string]interface{}{}
		}
		existing.Metadata["task"] = "first task"
		existing.Metadata["conversationId"] = "conv-1"
		existingIDs, _ := existing.Metadata["conversationIds"].([]interface{})
		seen := make(map[string]bool)
		for _, id := range existingIDs {
			if s, ok := id.(string); ok {
				seen[s] = true
			}
		}
		if !seen["conv-1"] {
			existingIDs = append(existingIDs, "conv-1")
		}
		existing.Metadata["conversationIds"] = existingIDs
		existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
		existing.Metadata["dispatches"] = append(existingDispatches, dispatchEntry1)
	})

	// Second dispatch for agent-designer — AppendOrUpdate coalesces.
	dispatchEntry2 := map[string]interface{}{
		"id":             "dispatch-ad-2",
		"task":           "second task",
		"status":         "done",
		"conversationId": "conv-2",
	}
	r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-2",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":            "second task",
			"conversationId":  "conv-2",
			"conversationIds": []interface{}{"conv-2"},
			"dispatches":      []interface{}{dispatchEntry2},
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-ad-2"
		existing.Status = "done"
		if existing.Metadata == nil {
			existing.Metadata = map[string]interface{}{}
		}
		existing.Metadata["task"] = "second task"
		existing.Metadata["conversationId"] = "conv-2"
		existingIDs, _ := existing.Metadata["conversationIds"].([]interface{})
		seen := make(map[string]bool)
		for _, id := range existingIDs {
			if s, ok := id.(string); ok {
				seen[s] = true
			}
		}
		if !seen["conv-2"] {
			existingIDs = append(existingIDs, "conv-2")
		}
		existing.Metadata["conversationIds"] = existingIDs
		existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
		existing.Metadata["dispatches"] = append(existingDispatches, dispatchEntry2)
	})

	// Different agent — single dispatch, AppendOrUpdate inserts.
	caDispatchEntry := map[string]interface{}{
		"id":     "dispatch-ca-1",
		"task":   "review architecture",
		"status": "error",
	}
	r.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "cloud-architect",
		ID:     "dispatch-ca-1",
		Status: "error",
		Metadata: map[string]interface{}{
			"task":       "review architecture",
			"dispatches": []interface{}{caDispatchEntry},
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-ca-1"
		existing.Status = "error"
		if existing.Metadata == nil {
			existing.Metadata = map[string]interface{}{}
		}
		existing.Metadata["task"] = "review architecture"
		existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
		existing.Metadata["dispatches"] = append(existingDispatches, caDispatchEntry)
	})

	merged := r.MergedSnapshot()

	// 2 entries: agent-designer (coalesced) + cloud-architect.
	if len(merged) != 2 {
		t.Fatalf("expected 2 entries, got %d: %v", len(merged), names(merged))
	}

	// Verify exactly 1 agent-designer entry (coalesced, not duplicated).
	adCount := 0
	for _, s := range merged {
		if s.Name == "agent-designer" {
			adCount++

			// Latest dispatch fields should win.
			if s.ID != "dispatch-ad-2" {
				t.Errorf("agent-designer ID = %q, want dispatch-ad-2", s.ID)
			}
			if s.Metadata["task"] != "second task" {
				t.Errorf("agent-designer task = %v, want second task", s.Metadata["task"])
			}
			if s.Metadata["conversationId"] != "conv-2" {
				t.Errorf("agent-designer conversationId = %v, want conv-2", s.Metadata["conversationId"])
			}

			// conversationIds should contain both conv-1 and conv-2.
			convIDs, ok := s.Metadata["conversationIds"].([]interface{})
			if !ok {
				t.Fatalf("agent-designer conversationIds is not []interface{}: %T", s.Metadata["conversationIds"])
			}
			if len(convIDs) != 2 {
				t.Errorf("agent-designer conversationIds length = %d, want 2: %v", len(convIDs), convIDs)
			}
			idSet := map[string]bool{}
			for _, id := range convIDs {
				idSet[id.(string)] = true
			}
			if !idSet["conv-1"] || !idSet["conv-2"] {
				t.Errorf("agent-designer conversationIds should contain conv-1 and conv-2, got %v", convIDs)
			}

			// dispatches array should have 2 entries.
			dispatches, ok := s.Metadata["dispatches"].([]interface{})
			if !ok {
				t.Fatalf("agent-designer dispatches is not []interface{}: %T", s.Metadata["dispatches"])
			}
			if len(dispatches) != 2 {
				t.Errorf("agent-designer dispatches length = %d, want 2", len(dispatches))
			}
		}
	}
	if adCount != 1 {
		t.Errorf("expected 1 agent-designer entry (coalesced), got %d", adCount)
	}
}
