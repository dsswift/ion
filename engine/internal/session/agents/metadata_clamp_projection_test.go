package agents

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestClampSnapshotCopy_BoundsProjectionWithoutMutatingSource(t *testing.T) {
	original := bigString(DefaultMaxValueBytes * 2)
	states := []types.AgentStateUpdate{{Name: "agent", Metadata: map[string]any{
		"displayName": "Agent", "lastWork": original,
		"nested": map[string]any{"full": original},
	}}}

	projected, reports := ClampSnapshotCopy(states, DefaultMetadataLimits(), testAttr)
	if len(reports) == 0 || projected[0].Metadata["_truncated"] != true {
		t.Fatal("expected bounded projection with a truncation marker")
	}
	if states[0].Metadata["lastWork"] != original {
		t.Fatal("clamping the outbound projection mutated registry source data")
	}
	if states[0].Metadata["nested"].(map[string]any)["full"] != original {
		t.Fatal("clamping nested outbound metadata mutated registry source data")
	}
}

func TestClampSnapshotCopy_BoundsDispatchFieldsWithoutChangingShape(t *testing.T) {
	limits := DefaultMetadataLimits()
	limits.MaxEntryBytes = 256
	limits.MaxValueBytes = 64
	original := bigString(4096)
	states := []types.AgentStateUpdate{{Name: "agent", Metadata: map[string]any{
		"displayName": "Agent", "dispatches": []any{map[string]any{
			"id": "dispatch-id", "conversationId": "conversation-id", "status": "done", "task": original,
		}},
	}}}

	projected, _ := ClampSnapshotCopy(states, limits, testAttr)
	dispatches, ok := projected[0].Metadata["dispatches"].([]any)
	if !ok {
		t.Fatalf("dispatches changed type: %T", projected[0].Metadata["dispatches"])
	}
	if len(dispatches) > 0 {
		entry := dispatches[0].(map[string]any)
		for _, key := range []string{"id", "conversationId", "status"} {
			if _, ok := entry[key].(string); !ok {
				t.Fatalf("%s changed shape: %#v", key, entry[key])
			}
		}
		if task, _ := entry["task"].(string); len(task) > limits.MaxValueBytes {
			t.Fatalf("task bytes = %d", len(task))
		}
	}
	if states[0].Metadata["dispatches"].([]any)[0].(map[string]any)["task"] != original {
		t.Fatal("projection mutated source dispatch")
	}
}

func TestClampSnapshotCopy_ProtectedScalarIsBoundedAndSourceRemainsExact(t *testing.T) {
	original := bigString(DefaultMaxValueBytes * 2)
	states := []types.AgentStateUpdate{{Name: "agent", Metadata: map[string]any{"displayName": original}}}
	projected, _ := ClampSnapshotCopy(states, DefaultMetadataLimits(), testAttr)
	got := projected[0].Metadata["displayName"].(string)
	if len(got) > DefaultMaxValueBytes || got == original {
		t.Fatalf("projected displayName = %d bytes", len(got))
	}
	if states[0].Metadata["displayName"] != original {
		t.Fatal("projection mutated source displayName")
	}
}

func TestFullMergedSnapshot_DetachesExtensionMetadata(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{{Name: "extension", Status: "idle", Metadata: map[string]any{
		"nested": map[string]any{"value": "original"},
	}}})

	snapshot := r.FullMergedSnapshot()
	snapshot[0].Metadata["nested"].(map[string]any)["value"] = "changed"
	again := r.FullMergedSnapshot()
	if got := again[0].Metadata["nested"].(map[string]any)["value"]; got != "original" {
		t.Fatalf("full snapshot shared extension metadata: %q", got)
	}
}
