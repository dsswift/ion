package agents

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- MergedSnapshot deduplication ---

// TestMergedSnapshot_DeduplicatesByName verifies that when both the
// extension cache and the engine states contain an entry with the same
// name, MergedSnapshot returns only the engine-managed entry. This
// prevents duplicate rows in the agent panel when both the extension's
// roster and the engine's dispatch state track the same specialist.
func TestMergedSnapshot_DeduplicatesByName(t *testing.T) {
	r := NewRegistry()
	// Extension roster: agent-designer at idle
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "idle", Metadata: map[string]interface{}{
			"displayName": "Agent Designer",
		}},
	})
	// Engine dispatch: agent-designer at running with richer metadata
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-agent-designer-123",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Agent Designer",
			"task":        "brief me",
			"model":       "claude-sonnet-4-6",
		},
	})

	merged := r.MergedSnapshot()

	// Should have 2 entries: ion-tutor (ext only) + agent-designer (engine wins)
	if len(merged) != 2 {
		t.Fatalf("expected 2 merged entries, got %d: %v", len(merged), names(merged))
	}

	// ion-tutor should come from extension (no engine override)
	if merged[0].Name != "ion-tutor" || merged[0].Status != "idle" {
		t.Errorf("expected ion-tutor/idle, got %s/%s", merged[0].Name, merged[0].Status)
	}

	// agent-designer should come from engine (running, with task metadata)
	if merged[1].Name != "agent-designer" || merged[1].Status != "running" {
		t.Errorf("expected agent-designer/running, got %s/%s", merged[1].Name, merged[1].Status)
	}
	if merged[1].Metadata["task"] != "brief me" {
		t.Errorf("expected engine metadata with task, got %v", merged[1].Metadata)
	}
	if merged[1].ID != "dispatch-agent-designer-123" {
		t.Errorf("expected engine ID, got %q", merged[1].ID)
	}
}

// TestMergedSnapshot_NoEngineOverride verifies that extension-only entries
// pass through unchanged when the engine has no matching state.
func TestMergedSnapshot_NoEngineOverride(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "idle"},
	})

	merged := r.MergedSnapshot()
	if len(merged) != 2 {
		t.Fatalf("expected 2, got %d", len(merged))
	}
}

// TestMergedSnapshot_EngineOnlyNoExtension verifies engine-managed entries
// appear when no extension states are cached.
func TestMergedSnapshot_EngineOnlyNoExtension(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "agent-1", ID: "agent-1", Status: "running"})

	merged := r.MergedSnapshot()
	if len(merged) != 1 || merged[0].Name != "agent-1" {
		t.Fatalf("expected [agent-1], got %v", names(merged))
	}
}

// --- ClearRunningStates ---

// TestClearRunningStates_PreservesDone verifies that completed agents
// survive ClearRunningStates so their conversation history persists
// across run boundaries.
func TestClearRunningStates_PreservesDone(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "a", Status: "running"})
	r.AppendState(types.AgentStateUpdate{
		Name:   "b",
		Status: "done",
		Metadata: map[string]interface{}{
			"conversationId": "conv-123",
			"task":           "do something",
		},
	})
	r.AppendState(types.AgentStateUpdate{Name: "c", Status: "error"})
	r.AppendState(types.AgentStateUpdate{Name: "d", Status: "cancelled"})

	r.ClearRunningStates()
	merged := r.MergedSnapshot()

	if len(merged) != 3 {
		t.Fatalf("expected 3 (done+error+cancelled), got %d: %v", len(merged), names(merged))
	}
	for _, s := range merged {
		if s.Status == "running" {
			t.Errorf("running agent %q should have been cleared", s.Name)
		}
	}
	// Verify metadata survives
	for _, s := range merged {
		if s.Name == "b" {
			if s.Metadata["conversationId"] != "conv-123" {
				t.Errorf("expected conversationId preserved, got %v", s.Metadata)
			}
		}
	}
}

// --- UpdateStateByID ---

// TestUpdateStateByID verifies that ID-based updates target the correct
// entry even when multiple entries share the same name.
func TestUpdateStateByID(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "agent-designer", ID: "dispatch-1", Status: "done"})
	r.AppendState(types.AgentStateUpdate{Name: "other", ID: "dispatch-2", Status: "running"})

	r.UpdateStateByID("dispatch-2", func(s *types.AgentStateUpdate) {
		s.Status = "done"
		if s.Metadata == nil {
			s.Metadata = map[string]interface{}{}
		}
		s.Metadata["elapsed"] = 42.0
	})

	merged := r.MergedSnapshot()
	for _, s := range merged {
		if s.ID == "dispatch-2" {
			if s.Status != "done" {
				t.Errorf("expected done, got %s", s.Status)
			}
			if s.Metadata["elapsed"] != 42.0 {
				t.Errorf("expected elapsed=42, got %v", s.Metadata["elapsed"])
			}
			return
		}
	}
	t.Error("dispatch-2 not found in merged snapshot")
}

// --- FindStateIndex ---

// TestFindStateIndex verifies name-based lookup for re-dispatch detection.
func TestFindStateIndex(t *testing.T) {
	r := NewRegistry()
	r.AppendState(types.AgentStateUpdate{Name: "a", Status: "done"})
	r.AppendState(types.AgentStateUpdate{Name: "b", Status: "running"})

	if r.FindStateIndex("a") != 0 {
		t.Errorf("expected index 0 for 'a', got %d", r.FindStateIndex("a"))
	}
	if r.FindStateIndex("b") != 1 {
		t.Errorf("expected index 1 for 'b', got %d", r.FindStateIndex("b"))
	}
	if r.FindStateIndex("nonexistent") != -1 {
		t.Errorf("expected -1 for nonexistent, got %d", r.FindStateIndex("nonexistent"))
	}
}

// --- Re-dispatch scenario ---

// TestReDispatch_UpdatesExistingEntry verifies that dispatching the same
// specialist twice updates the existing entry instead of creating a
// duplicate row.
func TestReDispatch_UpdatesExistingEntry(t *testing.T) {
	r := NewRegistry()

	// First dispatch
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"task":            "first task",
			"conversationIds": []interface{}{"conv-1"},
			"conversationId":  "conv-1",
		},
	})

	// Second dispatch — should update, not append
	idx := r.FindStateIndex("agent-designer")
	if idx < 0 {
		t.Fatal("expected existing entry for re-dispatch")
	}

	r.UpdateState("agent-designer", func(s *types.AgentStateUpdate) {
		s.ID = "dispatch-2"
		s.Status = "running"
		s.Metadata["task"] = "second task"
		s.Metadata["lastWork"] = ""
		delete(s.Metadata, "elapsed")
	})

	merged := r.MergedSnapshot()

	// Should still have exactly 1 entry for agent-designer
	count := 0
	for _, s := range merged {
		if s.Name == "agent-designer" {
			count++
			if s.Status != "running" {
				t.Errorf("expected running after re-dispatch, got %s", s.Status)
			}
			if s.ID != "dispatch-2" {
				t.Errorf("expected dispatch-2 ID, got %s", s.ID)
			}
			if s.Metadata["task"] != "second task" {
				t.Errorf("expected second task, got %v", s.Metadata["task"])
			}
			// conversationIds from first dispatch should still be there
			ids, ok := s.Metadata["conversationIds"].([]interface{})
			if !ok || len(ids) != 1 || ids[0] != "conv-1" {
				t.Errorf("expected preserved conversationIds, got %v", s.Metadata["conversationIds"])
			}
		}
	}
	if count != 1 {
		t.Errorf("expected exactly 1 agent-designer entry, got %d", count)
	}
}

// --- Full lifecycle: extension roster + engine dispatch + completion ---

// TestFullLifecycle_ExtensionRosterPlusDispatch simulates the complete
// extension flow: extension caches a roster, engine dispatches one
// specialist, progress updates flow, agent completes with conversationId.
func TestFullLifecycle_ExtensionRosterPlusDispatch(t *testing.T) {
	r := NewRegistry()

	// Step 1: Extension emits initial roster (9 specialists all idle)
	roster := []types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle", Metadata: map[string]interface{}{"displayName": "Tutor"}},
		{Name: "agent-designer", Status: "idle", Metadata: map[string]interface{}{"displayName": "Agent Designer"}},
		{Name: "hook-specialist", Status: "idle", Metadata: map[string]interface{}{"displayName": "Hook Specialist"}},
	}
	r.CacheExtStates(roster)

	snap1 := r.MergedSnapshot()
	if len(snap1) != 3 {
		t.Fatalf("step1: expected 3 agents, got %d", len(snap1))
	}

	// Step 2: Engine dispatches agent-designer (creates engine-managed entry)
	r.AppendState(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "running",
		Metadata: map[string]interface{}{
			"displayName": "Agent Designer",
			"task":        "brief me on agent design",
			"model":       "claude-sonnet-4-6",
			"startTime":   1234567890,
		},
	})

	snap2 := r.MergedSnapshot()
	// Should be 3 entries, NOT 4 (engine's agent-designer replaces extension's)
	if len(snap2) != 3 {
		t.Fatalf("step2: expected 3 agents (deduped), got %d: %v", len(snap2), names(snap2))
	}

	// Find agent-designer — should have engine's metadata
	var ad *types.AgentStateUpdate
	for i := range snap2 {
		if snap2[i].Name == "agent-designer" {
			ad = &snap2[i]
			break
		}
	}
	if ad == nil {
		t.Fatal("step2: agent-designer not found")
	}
	if ad.Status != "running" {
		t.Errorf("step2: expected running, got %s", ad.Status)
	}
	if ad.Metadata["task"] != "brief me on agent design" {
		t.Errorf("step2: expected task from engine, got %v", ad.Metadata["task"])
	}

	// Step 3: Extension re-emits roster with agent-designer at running
	// (from its agent_start hook). This should NOT create a duplicate.
	rosterRunning := []types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "running", Metadata: map[string]interface{}{
			"displayName": "Agent Designer",
			"startTime":   9999, // extension's startTime
		}},
		{Name: "hook-specialist", Status: "idle"},
	}
	r.CacheExtStates(rosterRunning)

	snap3 := r.MergedSnapshot()
	if len(snap3) != 3 {
		t.Fatalf("step3: expected 3 (no duplicates), got %d: %v", len(snap3), names(snap3))
	}
	// Engine entry should still win
	for _, s := range snap3 {
		if s.Name == "agent-designer" {
			if s.Metadata["task"] != "brief me on agent design" {
				t.Errorf("step3: engine metadata should win, got %v", s.Metadata)
			}
		}
	}

	// Step 4: Progress update via UpdateStateByID
	r.UpdateStateByID("dispatch-ad-1", func(s *types.AgentStateUpdate) {
		s.Metadata["lastWork"] = "Using Read..."
	})
	snap4 := r.MergedSnapshot()
	for _, s := range snap4 {
		if s.Name == "agent-designer" {
			if s.Metadata["lastWork"] != "Using Read..." {
				t.Errorf("step4: expected progress update, got %v", s.Metadata["lastWork"])
			}
		}
	}

	// Step 5: Agent completes — terminal status + conversationId
	r.UpdateStateByID("dispatch-ad-1", func(s *types.AgentStateUpdate) {
		s.Status = "done"
		s.Metadata["elapsed"] = 32.5
		s.Metadata["lastWork"] = "Here is the agent design brief..."
		s.Metadata["conversationId"] = "conv-abc"
		existing, _ := s.Metadata["conversationIds"].([]interface{})
		s.Metadata["conversationIds"] = append(existing, "conv-abc")
	})

	snap5 := r.MergedSnapshot()
	if len(snap5) != 3 {
		t.Fatalf("step5: expected 3, got %d", len(snap5))
	}
	for _, s := range snap5 {
		if s.Name == "agent-designer" {
			if s.Status != "done" {
				t.Errorf("step5: expected done, got %s", s.Status)
			}
			if s.Metadata["conversationId"] != "conv-abc" {
				t.Errorf("step5: expected conversationId, got %v", s.Metadata)
			}
			ids, _ := s.Metadata["conversationIds"].([]interface{})
			if len(ids) != 1 || ids[0] != "conv-abc" {
				t.Errorf("step5: expected conversationIds=[conv-abc], got %v", ids)
			}
		}
	}

	// Step 6: Run exit — ClearRunningStates should preserve the done entry
	r.ClearRunningStates()
	snap6 := r.MergedSnapshot()

	// Extension roster still has 3 entries cached; engine has 1 done entry.
	// Dedup: engine's agent-designer (done) wins over extension's.
	foundAD := false
	for _, s := range snap6 {
		if s.Name == "agent-designer" {
			foundAD = true
			if s.Status != "done" {
				t.Errorf("step6: expected done after ClearRunningStates, got %s", s.Status)
			}
			if s.Metadata["conversationId"] != "conv-abc" {
				t.Errorf("step6: conversationId should survive, got %v", s.Metadata)
			}
		}
	}
	if !foundAD {
		t.Error("step6: agent-designer should survive ClearRunningStates")
	}

	// Step 7: Extension emits terminal snapshot (session_end) — wipes roster
	r.CacheExtStates(nil)
	snap7 := r.MergedSnapshot()
	// Only engine-managed done entry should remain
	if len(snap7) != 1 || snap7[0].Name != "agent-designer" {
		t.Fatalf("step7: expected [agent-designer], got %v", names(snap7))
	}
}

// --- Numbered-variant deduplication ---

// TestMergedSnapshot_NumberedVariantSupersedes verifies that an engine
// entry like "cloud-architect-7" (created when the LLM forgets the name
// parameter) supersedes the extension roster entry "cloud-architect",
// preventing duplicate/flickering rows.
func TestMergedSnapshot_NumberedVariantSupersedes(t *testing.T) {
	r := NewRegistry()
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "cloud-architect", Status: "running", Metadata: map[string]interface{}{
			"displayName": "Cloud Architect",
		}},
		{Name: "security-officer", Status: "idle"},
	})
	// Engine spawner created a numbered variant (LLM didn't pass name)
	r.AppendState(types.AgentStateUpdate{
		Name:   "cloud-architect-7",
		ID:     "cloud-architect-7",
		Status: "running",
		Metadata: map[string]interface{}{
			"task":     "evaluate architecture",
			"lastWork": "Evaluating security posture...",
		},
	})

	merged := r.MergedSnapshot()

	// Should have 2 entries: security-officer (ext only) + cloud-architect-7 (engine)
	// The extension's "cloud-architect" should be superseded by "cloud-architect-7"
	if len(merged) != 2 {
		t.Fatalf("expected 2, got %d: %v", len(merged), names(merged))
	}

	nameSet := map[string]bool{}
	for _, s := range merged {
		nameSet[s.Name] = true
	}
	if nameSet["cloud-architect"] {
		t.Error("extension's cloud-architect should be superseded by cloud-architect-7")
	}
	if !nameSet["cloud-architect-7"] {
		t.Error("engine's cloud-architect-7 should be present")
	}
	if !nameSet["security-officer"] {
		t.Error("security-officer should be present (not superseded)")
	}
}

// TestStripNumberedSuffix covers the suffix-stripping helper.
func TestStripNumberedSuffix(t *testing.T) {
	cases := []struct {
		input, want string
	}{
		{"cloud-architect-7", "cloud-architect"},
		{"agent-designer-12", "agent-designer"},
		{"agent-1", "agent"},
		{"simple", "simple"},
		{"no-suffix-here", "no-suffix-here"},
		{"trailing-dash-", "trailing-dash-"},
		{"", ""},
		{"a-0", "a"},
	}
	for _, tc := range cases {
		got := stripNumberedSuffix(tc.input)
		if got != tc.want {
			t.Errorf("stripNumberedSuffix(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func names(states []types.AgentStateUpdate) []string {
	out := make([]string, len(states))
	for i, s := range states {
		out[i] = s.Name
	}
	return out
}

// --- Roster-shadows-dispatch regression (empty agent pop-up) ---

// TestMergedSnapshot_RosterDispatchCarriesDispatchesArray pins the exact bug
// behind the "agent pop-up shows no dispatch information" report
// (conversation 1782775464107-cbe6a7f214d4): an always-visible extension
// roster row (dev-lead) and a single engine dispatch of the same name both
// exist; the merged snapshot must collapse to ONE dev-lead row that carries
// the dispatch's dispatches[] array. The desktop AgentPanel renders the
// pop-up from agent.metadata.dispatches (getDispatches), so if the roster row
// shadows the dispatch row, dispatches[] is absent and the pop-up renders
// empty. This test fails if the supersede/grouping projection regresses such
// that the dispatch's dispatches[] array does not reach the surviving row.
func TestMergedSnapshot_RosterDispatchCarriesDispatchesArray(t *testing.T) {
	r := NewRegistry()

	// Extension roster: dev-lead is always-visible and carries NO dispatches[].
	r.CacheExtStates([]types.AgentStateUpdate{
		{Name: "project-lead", Status: "idle", Metadata: map[string]interface{}{
			"displayName": "Project Lead",
			"visibility":  "always",
		}},
		{Name: "dev-lead", Status: "idle", Metadata: map[string]interface{}{
			"displayName": "Dev Lead",
			"visibility":  "always",
		}},
	})

	// Engine dispatch: a single done dev-lead carrying a one-element
	// dispatches[] array (the shape dispatch_agent.go writes at dispatch start
	// and persistTerminalDispatches/rehydrateDispatchState restore).
	r.AppendState(types.AgentStateUpdate{
		Name:   "dev-lead",
		ID:     "dispatch-dev-lead-1782778504707-cebebc7a0f4d",
		Status: "done",
		Metadata: map[string]interface{}{
			"displayName": "Dev Lead",
			"visibility":  "sticky",
			"invited":     true,
			"task":        "READ-ONLY verification pass",
			"model":       "claude-opus-4-6",
			"elapsed":     105.04,
			"dispatches": []interface{}{
				map[string]interface{}{
					"id":             "dispatch-dev-lead-1782778504707-cebebc7a0f4d",
					"task":           "READ-ONLY verification pass",
					"model":          "claude-opus-4-6",
					"status":         "done",
					"elapsed":        105.04,
					"conversationId": "1782778504707-736328111013",
				},
			},
		},
	})

	merged := r.MergedSnapshot()

	// Exactly one dev-lead row survives (roster row superseded by the dispatch
	// row); project-lead passes through. No duplicate dev-lead.
	var devLead *types.AgentStateUpdate
	devLeadCount := 0
	for i := range merged {
		if merged[i].Name == "dev-lead" {
			devLead = &merged[i]
			devLeadCount++
		}
	}
	if devLeadCount != 1 {
		t.Fatalf("expected exactly 1 dev-lead row, got %d: %v", devLeadCount, names(merged))
	}

	// The surviving dev-lead must carry the dispatch's dispatches[] array.
	// This is the field the desktop pop-up renders from; an empty/absent array
	// is the reported "no dispatch information" symptom.
	dispatches, ok := devLead.Metadata["dispatches"].([]interface{})
	if !ok {
		t.Fatalf("dev-lead row has no dispatches[] array (pop-up would render empty); metadata=%v", devLead.Metadata)
	}
	if len(dispatches) != 1 {
		t.Fatalf("expected dispatches[] length 1, got %d: %v", len(dispatches), dispatches)
	}

	// The single dispatch entry must carry the correct stable id so the pop-up
	// can load the right child conversation.
	entry, ok := dispatches[0].(map[string]interface{})
	if !ok {
		t.Fatalf("dispatch entry is not a map: %v", dispatches[0])
	}
	if entry["id"] != "dispatch-dev-lead-1782778504707-cebebc7a0f4d" {
		t.Errorf("expected dispatch id preserved, got %v", entry["id"])
	}
	if entry["conversationId"] != "1782778504707-736328111013" {
		t.Errorf("expected dispatch conversationId preserved, got %v", entry["conversationId"])
	}

	// The surviving row keeps the dispatch's terminal status and task (engine
	// row wins over the idle roster row).
	if devLead.Status != "done" {
		t.Errorf("expected dev-lead status=done (engine row wins), got %s", devLead.Status)
	}
	if devLead.Metadata["task"] != "READ-ONLY verification pass" {
		t.Errorf("expected dispatch task preserved, got %v", devLead.Metadata["task"])
	}
}

// TestProjectionLoggingHelpers pins the predicates that gate the projection's
// observability logging (MergedSnapshot / groupByName). isDispatchBearing and
// dispatchesLen decide whether the "pop-up would render empty" debug line
// fires: a row that carries a dispatch task but a zero-length dispatches[] is
// the exact pathological shape that the log must flag. Pinning the predicates
// keeps that signal correct independent of the log string.
func TestProjectionLoggingHelpers(t *testing.T) {
	t.Run("isDispatchBearing", func(t *testing.T) {
		cases := []struct {
			name string
			meta map[string]interface{}
			want bool
		}{
			{"nil metadata", nil, false},
			{"no task", map[string]interface{}{"displayName": "Dev Lead"}, false},
			{"empty task", map[string]interface{}{"task": ""}, false},
			{"non-string task", map[string]interface{}{"task": 42}, false},
			{"has task", map[string]interface{}{"task": "do the thing"}, true},
		}
		for _, tc := range cases {
			if got := isDispatchBearing(tc.meta); got != tc.want {
				t.Errorf("%s: isDispatchBearing = %v, want %v", tc.name, got, tc.want)
			}
		}
	})

	t.Run("dispatchesLen", func(t *testing.T) {
		cases := []struct {
			name string
			meta map[string]interface{}
			want int
		}{
			{"nil metadata", nil, 0},
			{"absent", map[string]interface{}{"task": "x"}, 0},
			{"wrong type", map[string]interface{}{"dispatches": "not-an-array"}, 0},
			{"empty array", map[string]interface{}{"dispatches": []interface{}{}}, 0},
			{"one entry", map[string]interface{}{"dispatches": []interface{}{
				map[string]interface{}{"id": "d1"},
			}}, 1},
			{"two entries", map[string]interface{}{"dispatches": []interface{}{
				map[string]interface{}{"id": "d1"},
				map[string]interface{}{"id": "d2"},
			}}, 2},
		}
		for _, tc := range cases {
			if got := dispatchesLen(tc.meta); got != tc.want {
				t.Errorf("%s: dispatchesLen = %d, want %d", tc.name, got, tc.want)
			}
		}
	})

	// The combined predicate that the logging keys on: a dispatch-bearing row
	// with a zero-length dispatches[] is the empty-pop-up signature.
	t.Run("empty-pop-up signature", func(t *testing.T) {
		meta := map[string]interface{}{"task": "verify", "displayName": "Dev Lead"}
		if !isDispatchBearing(meta) || dispatchesLen(meta) != 0 {
			t.Fatalf("roster-shadowed dispatch row should match the empty-pop-up signature: bearing=%v len=%d",
				isDispatchBearing(meta), dispatchesLen(meta))
		}
		// A healthy dispatch row must NOT match the signature.
		healthy := map[string]interface{}{"task": "verify", "dispatches": []interface{}{
			map[string]interface{}{"id": "d1"},
		}}
		if isDispatchBearing(healthy) && dispatchesLen(healthy) == 0 {
			t.Fatal("healthy dispatch row should not match the empty-pop-up signature")
		}
	})
}
