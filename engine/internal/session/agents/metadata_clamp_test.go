package agents

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
)

func bigString(n int) string { return strings.Repeat("x", n) }

// TestClampMetadata_TruncatesOversizedStringValue is the per-value tier: one
// giant string is the shape of the actual production bug.
func TestClampMetadata_TruncatesOversizedStringValue(t *testing.T) {
	state := types.AgentStateUpdate{
		Name:   "cloud-architect",
		Status: "done",
		Metadata: map[string]any{
			"displayName": "Cloud Architect",
			"lastWork":    bigString(3 * 1024 * 1024),
		},
	}

	rep := clampEntry(&state, DefaultMetadataLimits())
	if rep == nil {
		t.Fatal("expected a clamp report for a 3 MB value")
	}

	got, _ := state.Metadata["lastWork"].(string)
	if len(got) > DefaultMaxValueBytes {
		t.Errorf("lastWork = %d bytes, want <= %d", len(got), DefaultMaxValueBytes)
	}
	if !strings.HasSuffix(got, truncationSuffix) {
		t.Error("clamped value should carry the truncation suffix")
	}
	if state.Metadata["_truncated"] != true {
		t.Error("clamped entry should be marked _truncated in band")
	}
}

// TestClampMetadata_IsUTF8Safe pins the property a byte slice would violate.
// Invalid UTF-8 makes the whole JSON frame undecodable for a strict consumer,
// so a naive cut turns a large snapshot into no snapshot at all.
func TestClampMetadata_IsUTF8Safe(t *testing.T) {
	// 4-byte runes guarantee the cut offset lands mid-sequence.
	state := types.AgentStateUpdate{
		Name:     "a",
		Metadata: map[string]any{"lastWork": strings.Repeat("🙂", 4000)},
	}

	clampEntry(&state, DefaultMetadataLimits())

	got, _ := state.Metadata["lastWork"].(string)
	if !utf8.ValidString(got) {
		t.Error("clamped value is not valid UTF-8")
	}
	if len(got) > DefaultMaxValueBytes {
		t.Errorf("clamped value = %d bytes, want <= %d", len(got), DefaultMaxValueBytes)
	}
}

// TestClampMetadata_PreservesProtectedKeys covers both reasons a key is
// protected: displayName keeps the engine's own validator happy, and
// visibility/invited keep the row visible on iOS, whose decoder defaults an
// absent visibility to "ephemeral" (rendered only while running).
func TestClampMetadata_PreservesProtectedKeys(t *testing.T) {
	md := map[string]any{
		"displayName": "Cloud Architect",
		"type":        "specialist",
		"visibility":  "sticky",
		"invited":     true,
		"dispatchId":  "disp-1",
	}
	// Blow the entry budget with junk the clamp is allowed to drop.
	for i := 0; i < 400; i++ {
		md["junk"+string(rune('a'+i%26))+string(rune('a'+i/26))] = bigString(1024)
	}
	state := types.AgentStateUpdate{Name: "cloud-architect", Metadata: md}

	clampEntry(&state, DefaultMetadataLimits())

	for _, key := range []string{"displayName", "type", "visibility", "invited", "dispatchId"} {
		if _, ok := state.Metadata[key]; !ok {
			t.Errorf("protected key %q was dropped by the entry budget", key)
		}
	}
	if got := approxMapBytes(state.Metadata); got > DefaultMaxEntryBytes {
		t.Errorf("entry = %d bytes after clamp, want <= %d", got, DefaultMaxEntryBytes)
	}
}

// TestClampMetadata_ProtectedKeyValuesAreStillClamped is the distinction the
// word "protected" hides: protection means "never removed", not "never
// bounded". Were it otherwise, one 3 MB displayName would walk straight
// through the bound via a protected path.
func TestClampMetadata_ProtectedKeyValuesAreStillClamped(t *testing.T) {
	state := types.AgentStateUpdate{
		Name:     "a",
		Metadata: map[string]any{"displayName": bigString(3 * 1024 * 1024)},
	}

	clampEntry(&state, DefaultMetadataLimits())

	got, ok := state.Metadata["displayName"].(string)
	if !ok {
		t.Fatal("displayName must survive as a string")
	}
	if len(got) > DefaultMaxValueBytes {
		t.Errorf("protected displayName = %d bytes, want clamped to <= %d", len(got), DefaultMaxValueBytes)
	}
}

// TestClampMetadata_RecursesIntoDispatchesArray guards the array consumers key
// per-dispatch UI state on: it must be bounded from the inside, not discarded.
func TestClampMetadata_RecursesIntoDispatchesArray(t *testing.T) {
	state := types.AgentStateUpdate{
		Name: "a",
		Metadata: map[string]any{
			"displayName": "A",
			"dispatches": []any{
				map[string]any{"id": "d1", "status": "running", "task": bigString(2 * 1024 * 1024)},
			},
		},
	}

	clampEntry(&state, DefaultMetadataLimits())

	arr, ok := state.Metadata["dispatches"].([]any)
	if !ok || len(arr) != 1 {
		t.Fatalf("dispatches array must survive clamping, got %#v", state.Metadata["dispatches"])
	}
	entry, ok := arr[0].(map[string]any)
	if !ok {
		t.Fatalf("dispatch entry must remain a map, got %T", arr[0])
	}
	if entry["id"] != "d1" || entry["status"] != "running" {
		t.Error("per-dispatch identity must survive clamping")
	}
	if task, _ := entry["task"].(string); len(task) > DefaultMaxValueBytes {
		t.Errorf("nested task = %d bytes, want <= %d", len(task), DefaultMaxValueBytes)
	}
}

// TestClampMetadata_SnapshotBudgetKeepsEveryAgent covers the count-explosion
// tier. Dropping an AGENT is never allowed: the event is a complete snapshot
// applied by replacement, so omitting one tells consumers it is gone.
func TestClampMetadata_SnapshotBudgetKeepsEveryAgent(t *testing.T) {
	states := make([]types.AgentStateUpdate, 200)
	for i := range states {
		states[i] = types.AgentStateUpdate{
			Name:   "agent-" + string(rune('a'+i%26)) + string(rune('a'+i/26)),
			Status: "running",
			Metadata: map[string]any{
				"displayName": "Agent",
				"visibility":  "always",
				"bulk":        bigString(60 * 1024),
			},
		}
	}

	clampStates(states, DefaultMetadataLimits())

	total := 0
	for i := range states {
		total += approxMapBytes(states[i].Metadata)
		if states[i].Name == "" || states[i].Status == "" {
			t.Fatal("clamp must never strip an agent's identity")
		}
		if _, ok := states[i].Metadata["displayName"]; !ok {
			t.Errorf("agent %d lost displayName to the snapshot budget", i)
		}
	}
	if total > DefaultMaxSnapshotBytes {
		t.Errorf("snapshot = %d bytes after clamp, want <= %d", total, DefaultMaxSnapshotBytes)
	}
	if len(states) != 200 {
		t.Errorf("agent count changed: %d, want 200", len(states))
	}
}

func TestClampMetadata_DisabledWithNegativeOne(t *testing.T) {
	original := bigString(3 * 1024 * 1024)
	state := types.AgentStateUpdate{Name: "a", Metadata: map[string]any{"lastWork": original}}

	limits := DefaultMetadataLimits()
	limits.MaxValueBytes = LimitsDisabled
	limits.MaxEntryBytes = LimitsDisabled
	limits.MaxSnapshotBytes = LimitsDisabled

	if rep := clampEntry(&state, limits); rep != nil {
		t.Errorf("expected no clamp when every tier is disabled, got %+v", rep)
	}
	if state.Metadata["lastWork"] != original {
		t.Error("disabled clamp must pass the value through verbatim")
	}
}

// TestCacheExtStates_BoundsOversizedRoster is the canonical red-on-revert
// test: 11 agents at ~3.3 MB each is the exact production payload that
// exceeded the desktop's 6 MiB cap on 1,873 consecutive attempts.
func TestCacheExtStates_BoundsOversizedRoster(t *testing.T) {
	r := NewRegistry()

	roster := make([]types.AgentStateUpdate, 11)
	for i := range roster {
		roster[i] = types.AgentStateUpdate{
			Name:   "agent-" + string(rune('a'+i)),
			Status: "running",
			Metadata: map[string]any{
				"displayName": "Agent",
				"visibility":  "always",
				"invited":     true,
				"lastWork":    bigString(3 * 1024 * 1024),
			},
		}
	}
	r.CacheExtStates(roster)

	encoded, err := json.Marshal(r.MergedSnapshot())
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	if len(encoded) > DefaultMaxSnapshotBytes {
		t.Errorf("serialized snapshot = %d bytes, want <= %d", len(encoded), DefaultMaxSnapshotBytes)
	}
	// The desktop transport cap is 6 MiB; the whole point is fitting under it.
	if len(encoded) > 6*1024*1024 {
		t.Errorf("serialized snapshot = %d bytes, still exceeds the 6 MiB transport cap", len(encoded))
	}

	if reports := r.TakeClampReports(); len(reports) == 0 {
		t.Error("expected clamp reports so the advisory can be emitted")
	}
	if second := r.TakeClampReports(); second != nil {
		t.Error("TakeClampReports must drain; a second call should return nil")
	}
}

// TestClampReports_CarryNoOffendingContent pins the no-echo guarantee. A
// report that embedded the clamped string would recreate the 35 MB payload in
// whatever consumed it.
func TestClampReports_CarryNoOffendingContent(t *testing.T) {
	needle := strings.Repeat("SECRETNEEDLE", 100000)
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{{
		Name:     "a",
		Metadata: map[string]any{"displayName": "A", "lastWork": needle},
	}})

	reports := r.TakeClampReports()
	if len(reports) == 0 {
		t.Fatal("expected a clamp report")
	}
	encoded, err := json.Marshal(reports)
	if err != nil {
		t.Fatalf("marshal reports: %v", err)
	}
	if strings.Contains(string(encoded), "SECRETNEEDLE") {
		t.Error("clamp report must carry key names and byte counts only, never the content")
	}
	if len(encoded) > 4096 {
		t.Errorf("clamp report serialized to %d bytes; reports must stay small", len(encoded))
	}
}

func TestClampMetadata_IsDeterministic(t *testing.T) {
	build := func() types.AgentStateUpdate {
		md := map[string]any{"displayName": "A"}
		for i := 0; i < 200; i++ {
			md["k"+string(rune('a'+i%26))+string(rune('a'+i/26))] = bigString(1024)
		}
		return types.AgentStateUpdate{Name: "a", Metadata: md}
	}

	a, b := build(), build()
	clampEntry(&a, DefaultMetadataLimits())
	clampEntry(&b, DefaultMetadataLimits())

	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Error("clamping the same input twice must produce the same output")
	}
}
