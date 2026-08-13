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

	projected, reports := ClampSnapshotCopy(states, DefaultMetadataLimits())
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

func TestClampSnapshotCopy_NeverCorruptsDispatchIdentity(t *testing.T) {
	limits := DefaultMetadataLimits()
	limits.MaxEntryBytes = 128
	limits.MaxValueBytes = 64
	states := []types.AgentStateUpdate{{Name: "agent", Metadata: map[string]any{
		"displayName": "Agent", "dispatches": []any{map[string]any{
			"id": "dispatch-id", "conversationId": "conversation-id", "status": "done", "task": bigString(4096),
		}},
	}}}

	projected, _ := ClampSnapshotCopy(states, limits)
	dispatches, ok := projected[0].Metadata["dispatches"].([]any)
	if !ok || len(dispatches) != 1 {
		t.Fatalf("dispatches lost type or entries: %#v", projected[0].Metadata["dispatches"])
	}
	entry := dispatches[0].(map[string]any)
	if entry["id"] != "dispatch-id" || entry["conversationId"] != "conversation-id" || entry["status"] != "done" {
		t.Fatalf("dispatch identity corrupted: %#v", entry)
	}
}

func TestClampSnapshotCopy_PreservesOversizedIdentityValues(t *testing.T) {
	identity := bigString(DefaultMaxValueBytes * 2)
	states := []types.AgentStateUpdate{{Name: "agent", Metadata: map[string]any{
		"displayName": "Agent", "dispatches": []any{map[string]any{
			"id": identity, "conversationId": identity, "status": "done", "task": bigString(DefaultMaxValueBytes * 2),
		}},
	}}}

	projected, _ := ClampSnapshotCopy(states, DefaultMetadataLimits())
	entry := projected[0].Metadata["dispatches"].([]any)[0].(map[string]any)
	if entry["id"] != identity || entry["conversationId"] != identity || entry["status"] != "done" {
		t.Fatalf("clamp altered routing identity: %#v", entry)
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
