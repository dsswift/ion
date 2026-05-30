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
// multiple dispatch records for different agents (including
// re-dispatches of the same agent) all populate correctly.
func TestPopulateFromDispatchRecords_MultipleDispatches(t *testing.T) {
	r := NewRegistry()

	// Agent-designer dispatched twice (two separate records from disk).
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":            "first task",
			"conversationId":  "conv-1",
			"conversationIds": []interface{}{"conv-1"},
		},
	})
	// In practice the rehydration loop appends every persisted record.
	// The second dispatch for the same agent shows up as a second entry.
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-2",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":            "second task",
			"conversationId":  "conv-2",
			"conversationIds": []interface{}{"conv-2"},
		},
	})

	// Different agent.
	r.AppendState(types.AgentStateUpdate{
		Name:   "cloud-architect",
		ID:     "dispatch-ca-1",
		Status: "error",
		Metadata: map[string]interface{}{
			"task": "review architecture",
		},
	})

	merged := r.MergedSnapshot()

	// All 3 entries should be present (no ext states to dedup against).
	if len(merged) != 3 {
		t.Fatalf("expected 3 entries, got %d: %v", len(merged), names(merged))
	}

	// Verify the second agent-designer entry is the one that appears
	// when looking up by name (FindStateIndex returns first match,
	// but all entries exist in the slice).
	adCount := 0
	for _, s := range merged {
		if s.Name == "agent-designer" {
			adCount++
		}
	}
	if adCount != 2 {
		t.Errorf("expected 2 agent-designer entries, got %d", adCount)
	}
}
