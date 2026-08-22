// metadata_clamp_bounds_test.go — the bound INVARIANT, pinned.
//
// These tests exist because the entry bound was once unenforceable: a
// protected key holding a large collection (dispatches[]) evaded the
// per-value string clamp and could not be dropped, so production advisories
// recorded clamped_bytes ABOVE limit_bytes while a 13-agent roster grew to
// 30.7 MB. Every test here fails on that code. The contract under test:
// after clamping, the approx entry size is ≤ MaxEntryBytes and the approx
// roster size is ≤ MaxSnapshotBytes — always, for any input shape.
package agents

import (
	"fmt"
	"math/rand"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// dispatchRecord builds a realistic small dispatch entry — the shape whose
// accumulation caused the production payload.
func dispatchRecord(i int, taskBytes int) map[string]any {
	task := make([]byte, taskBytes)
	for j := range task {
		task[j] = 'x'
	}
	return map[string]any{
		"id":             fmt.Sprintf("dispatch-%06d", i),
		"dispatchId":     fmt.Sprintf("dispatch-%06d", i),
		"status":         "done",
		"task":           string(task),
		"conversationId": fmt.Sprintf("conv-%06d", i),
		"elapsed":        i,
	}
}

func dispatchArray(n, taskBytes int) []any {
	out := make([]any, n)
	for i := range out {
		out[i] = dispatchRecord(i, taskBytes)
	}
	return out
}

// TestClampEntry_BoundInvariant_ProtectedCollection pins the production
// pathology directly: a protected dispatches[] array of thousands of small
// records must be brought under the entry bound.
func TestClampEntry_BoundInvariant_ProtectedCollection(t *testing.T) {
	l := DefaultMetadataLimits()
	// Adversarial by construction: every record's task is under the per-value
	// bound (so the string clamp never fires) and the array is within the
	// retention cap after truncation (50 × ~3.1 KB ≈ 157 KB), yet the entry
	// exceeds its 64 KB budget. Only a byte-bound on the protected collection
	// itself can enforce the invariant here.
	state := types.AgentStateUpdate{
		Name: "infra-engineer",
		Metadata: map[string]any{
			"displayName": "Infra Engineer",
			"type":        "specialist",
			"dispatches":  dispatchArray(10000, 3000),
			"task":        "current task",
		},
	}

	rep := clampEntry(&state, l, testAttr)
	if rep == nil {
		t.Fatal("expected a clamp report for an oversized entry")
	}
	if got := approxMapBytes(state.Metadata); got > l.MaxEntryBytes {
		t.Fatalf("entry bound violated: %d > %d", got, l.MaxEntryBytes)
	}
	if _, ok := state.Metadata["dispatches"]; !ok {
		t.Fatal("protected key dispatches must be retained")
	}
	if state.Metadata["_truncated"] != true {
		t.Fatal("expected in-band _truncated marker")
	}
}

// TestClampEntry_BoundInvariant_Property throws randomized nested shapes at
// the clamp and asserts the bound holds for every one. Seeded so a failure
// reproduces.
func TestClampEntry_BoundInvariant_Property(t *testing.T) {
	l := DefaultMetadataLimits()
	rng := rand.New(rand.NewSource(42))

	bigString := func(n int) string {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte('a' + rng.Intn(26))
		}
		return string(b)
	}

	for trial := 0; trial < 200; trial++ {
		md := map[string]any{"displayName": bigString(1 + rng.Intn(64))}
		// Random mix of protected and unprotected keys with adversarial values.
		for _, k := range []string{"dispatches", "type", "visibility", "task", "lastWork", "blob", "nested", "conversationId"} {
			switch rng.Intn(4) {
			case 0:
				md[k] = bigString(rng.Intn(3 * DefaultMaxValueBytes))
			case 1:
				md[k] = dispatchArray(rng.Intn(5000), rng.Intn(400))
			case 2:
				md[k] = map[string]any{
					"inner": bigString(rng.Intn(2 * DefaultMaxValueBytes)),
					"list":  dispatchArray(rng.Intn(1000), rng.Intn(200)),
				}
			case 3:
				md[k] = rng.Intn(1000)
			}
		}
		state := types.AgentStateUpdate{Name: fmt.Sprintf("agent-%d", trial), Metadata: md}
		clampEntry(&state, l, testAttr)
		if got := approxMapBytes(state.Metadata); got > l.MaxEntryBytes {
			t.Fatalf("trial %d: entry bound violated: %d > %d (keys: %v)", trial, got, l.MaxEntryBytes, sortedKeys(state.Metadata))
		}
	}
}

// TestClampSnapshot_BoundInvariant reproduces the production roster: 13
// agents at ~2.4 MB each must clamp to within the snapshot bound with no
// agent dropped.
func TestClampSnapshot_BoundInvariant(t *testing.T) {
	l := DefaultMetadataLimits()
	// Bypass the entry tier to prove the snapshot tier holds on its own.
	l.MaxValueBytes = LimitsDisabled
	l.MaxEntryBytes = LimitsDisabled
	l.MaxDispatchEntries = LimitsDisabled

	states := make([]types.AgentStateUpdate, 13)
	for i := range states {
		states[i] = types.AgentStateUpdate{
			Name: fmt.Sprintf("agent-%d", i),
			ID:   fmt.Sprintf("id-%d", i),
			Metadata: map[string]any{
				"displayName": fmt.Sprintf("Agent %d", i),
				"dispatches":  dispatchArray(10000, 200),
			},
		}
	}

	clampStates(states, l, testAttr)

	total := 0
	for i := range states {
		total += approxMapBytes(states[i].Metadata) + len(states[i].Name) + len(states[i].ID) + len(states[i].Status)
	}
	if total > l.MaxSnapshotBytes {
		t.Fatalf("snapshot bound violated: %d > %d", total, l.MaxSnapshotBytes)
	}
	if len(states) != 13 {
		t.Fatalf("no agent may be dropped: got %d", len(states))
	}
	for i := range states {
		if _, ok := states[i].Metadata["displayName"]; !ok {
			t.Fatalf("agent %d lost its displayName", i)
		}
	}
}

// TestClampEntry_DispatchesKeepsMostRecent pins retention semantics: the tail
// (most recent) survives, the total count is stamped, and the truncation is
// marked in-band.
func TestClampEntry_DispatchesKeepsMostRecent(t *testing.T) {
	l := DefaultMetadataLimits()
	state := types.AgentStateUpdate{
		Name:     "agent",
		Metadata: map[string]any{"displayName": "A", "dispatches": dispatchArray(137, 20)},
	}

	clampEntry(&state, l, testAttr)

	d, ok := state.Metadata["dispatches"].([]any)
	if !ok {
		t.Fatal("dispatches must remain an array")
	}
	if len(d) != l.MaxDispatchEntries {
		t.Fatalf("expected %d retained dispatches, got %d", l.MaxDispatchEntries, len(d))
	}
	last, ok := d[len(d)-1].(map[string]any)
	if !ok || last["id"] != "dispatch-000136" {
		t.Fatalf("tail (most recent) must be retained; got %v", d[len(d)-1])
	}
	if state.Metadata[dispatchesTotalKey] != 137 {
		t.Fatalf("expected dispatchesTotal=137, got %v", state.Metadata[dispatchesTotalKey])
	}
	keys, _ := state.Metadata["_truncatedKeys"].([]string)
	found := false
	for _, k := range keys {
		if k == "dispatches" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected dispatches in _truncatedKeys, got %v", keys)
	}
}

// TestClampReport_ClampedBytesWithinLimit pins advisory correctness: an
// entry-scope report may never claim a post-clamp size above its own limit —
// the exact lie production advisories told (65361..73477 against 65536).
func TestClampReport_ClampedBytesWithinLimit(t *testing.T) {
	l := DefaultMetadataLimits()
	state := types.AgentStateUpdate{
		Name: "agent",
		Metadata: map[string]any{
			"displayName": "Agent",
			"dispatches":  dispatchArray(10000, 200),
		},
	}

	rep := clampEntry(&state, l, testAttr)
	if rep == nil {
		t.Fatal("expected a clamp report")
	}
	if rep.Scope == "entry" && rep.ClampedBytes > rep.LimitBytes {
		t.Fatalf("advisory lies: clamped_bytes %d > limit_bytes %d", rep.ClampedBytes, rep.LimitBytes)
	}
}

// TestGroupByName_CapsMergedDispatches pins the projection-time retention
// bound: same-name entries whose merged history exceeds the cap emit only the
// most recent entries plus the total stamp.
func TestGroupByName_CapsMergedDispatches(t *testing.T) {
	var states []types.AgentStateUpdate
	for i := 0; i < 3; i++ {
		arr := make([]any, 40)
		for j := range arr {
			arr[j] = dispatchRecord(i*40+j, 20)
		}
		states = append(states, types.AgentStateUpdate{
			Name:     "worker",
			ID:       fmt.Sprintf("worker-%d", i),
			Status:   "done",
			Metadata: map[string]any{"displayName": "Worker", "dispatches": arr},
		})
	}

	out := groupByName(states, 50)
	if len(out) != 1 {
		t.Fatalf("expected one grouped row, got %d", len(out))
	}
	d, _ := out[0].Metadata["dispatches"].([]any)
	if len(d) != 50 {
		t.Fatalf("expected 50 retained dispatches, got %d", len(d))
	}
	if out[0].Metadata[dispatchesTotalKey] != 120 {
		t.Fatalf("expected dispatchesTotal=120, got %v", out[0].Metadata[dispatchesTotalKey])
	}
	last, _ := d[49].(map[string]any)
	if last["id"] != "dispatch-000119" {
		t.Fatalf("most recent dispatch must survive, got %v", last["id"])
	}
}
