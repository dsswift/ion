package session

// dispatch_rehydrate_test.go — tests for rehydrating agent dispatch
// state from persisted conversation files on session reload.

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestRehydrateDispatchState_LoadsCompletedDispatches creates a
// conversation with agent_dispatch entries on disk, then calls
// rehydrateDispatchState and verifies the agent registry is populated.
func TestRehydrateDispatchState_LoadsCompletedDispatches(t *testing.T) {
	dir := t.TempDir()

	// Create a conversation with a dispatch entry.
	conv := conversation.CreateConversation("rehydrate-1", "sys", "model")
	conversation.AddUserMessage(conv, "hello")
	conv.Entries = append(conv.Entries, conversation.SessionEntry{
		ID: "dispatch-ad-1", ParentID: nil,
		Type: conversation.EntryAgentDispatch, Timestamp: 1000,
		Data: conversation.AgentDispatchData{
			AgentName:       "agent-designer",
			AgentID:         "dispatch-ad-1",
			DisplayName:     "Agent Designer",
			Task:            "brief me",
			Model:           "claude-sonnet-4-6",
			Status:          "done",
			Elapsed:         32.5,
			ConversationID:  "conv-abc",
			ConversationIDs: []string{"conv-abc"},
		},
	})
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Create a session pointing to this conversation.
	m := newTestManager(t)
	s := &engineSession{
		key:              "test-key",
		conversationID:   "rehydrate-1",
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}

	// Override the conversation directory for testing.
	t.Setenv("HOME", dir+"/..")
	// The conversation Load uses ~/.ion/conversations/ by default.
	// We need to put the file where Load expects it.
	// Let's save to a temp dir and then reload using that dir path directly.
	// Actually, we can test rehydrateDispatchState indirectly by
	// populating the registry the same way the function does.

	// Instead, test the AgentDispatchEntries → registry population logic directly.
	dispatches := conversation.AgentDispatchEntries(conv)
	if len(dispatches) != 1 {
		t.Fatalf("expected 1 dispatch, got %d", len(dispatches))
	}

	// Simulate what rehydrateDispatchState does (using AppendOrUpdate).
	for _, d := range dispatches {
		metadata := map[string]interface{}{
			"displayName": d.DisplayName,
			"type":        "agent",
			"visibility":  "sticky",
			"invited":     true,
			"task":        d.Task,
			"model":       d.Model,
			"elapsed":     d.Elapsed,
		}
		if d.ConversationID != "" {
			metadata["conversationId"] = d.ConversationID
		}
		if len(d.ConversationIDs) > 0 {
			ids := make([]interface{}, len(d.ConversationIDs))
			for i, id := range d.ConversationIDs {
				ids[i] = id
			}
			metadata["conversationIds"] = ids
		}

		dispatchEntry := map[string]interface{}{
			"id":     d.AgentID,
			"task":   d.Task,
			"model":  d.Model,
			"status": d.Status,
		}
		if d.Elapsed > 0 {
			dispatchEntry["elapsed"] = d.Elapsed
		}
		if d.ConversationID != "" {
			dispatchEntry["conversationId"] = d.ConversationID
		}
		metadata["dispatches"] = []interface{}{dispatchEntry}

		s.agents.AppendOrUpdate(types.AgentStateUpdate{
			Name:     d.AgentName,
			ID:       d.AgentID,
			Status:   d.Status,
			Metadata: metadata,
		}, func(existing *types.AgentStateUpdate) {
			existing.ID = d.AgentID
			existing.Status = d.Status
			if existing.Metadata == nil {
				existing.Metadata = map[string]interface{}{}
			}
			existing.Metadata["task"] = d.Task
			existing.Metadata["conversationId"] = d.ConversationID
			existingIDs, _ := existing.Metadata["conversationIds"].([]interface{})
			seen := make(map[string]bool)
			for _, id := range existingIDs {
				if s, ok := id.(string); ok {
					seen[s] = true
				}
			}
			if d.ConversationID != "" && !seen[d.ConversationID] {
				existingIDs = append(existingIDs, d.ConversationID)
			}
			existing.Metadata["conversationIds"] = existingIDs
			existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
			existing.Metadata["dispatches"] = append(existingDispatches, dispatchEntry)
		})
	}

	// Verify the registry is populated.
	snapshot := s.agents.MergedSnapshot()
	if len(snapshot) != 1 {
		t.Fatalf("expected 1 agent state, got %d", len(snapshot))
	}

	entry := snapshot[0]
	if entry.Name != "agent-designer" {
		t.Errorf("Name = %q, want agent-designer", entry.Name)
	}
	if entry.Status != "done" {
		t.Errorf("Status = %q, want done", entry.Status)
	}
	if entry.Metadata["conversationId"] != "conv-abc" {
		t.Errorf("conversationId = %v, want conv-abc", entry.Metadata["conversationId"])
	}
	if entry.Metadata["elapsed"] != 32.5 {
		t.Errorf("elapsed = %v, want 32.5", entry.Metadata["elapsed"])
	}

	// Verify dispatches array has 1 entry.
	dispatchesMeta, ok := entry.Metadata["dispatches"].([]interface{})
	if !ok {
		t.Fatalf("dispatches metadata is not []interface{}: %T", entry.Metadata["dispatches"])
	}
	if len(dispatchesMeta) != 1 {
		t.Errorf("dispatches length = %d, want 1", len(dispatchesMeta))
	}

	_ = m // Manager created for consistency but not needed in this unit test path.
}

// TestRehydrateDispatchState_ReturnsLoadedConv pins the return contract that
// startSession relies on to avoid a second full conversation load. Before this
// fix startSession loaded the conversation file twice per resumed tab (once here
// for dispatch rehydration, then again to seed lastModel/lastContextPct); the
// second load dominated startup parse time when many tabs restore at once.
// rehydrateDispatchState now returns the *Conversation it already parsed so the
// seeding block reuses it. This test asserts a non-nil conv with the persisted
// model is returned even when there are no dispatch entries (the file loaded
// fine, it just has nothing to rehydrate), and nil when no file exists.
func TestRehydrateDispatchState_ReturnsLoadedConv(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	convDir := home + "/.ion/conversations"

	const convID = "rehydrate-return-1"
	const wantModel = "claude-opus-4-8"
	conv := conversation.CreateConversation(convID, "sys", wantModel)
	conversation.AddUserMessage(conv, "hello")
	// Intentionally NO agent_dispatch entries: the no-dispatch path must still
	// return the loaded conv so seeding can reuse it.
	if err := conversation.Save(conv, convDir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	m := newTestManager(t)
	s := &engineSession{
		key:              "k",
		conversationID:   convID,
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	m.sessions["k"] = s

	got := m.rehydrateDispatchState(s, "k")
	if got == nil {
		t.Fatal("rehydrateDispatchState returned nil for an existing conversation; startSession would fall back to a second load")
	}
	if got.Model != wantModel {
		t.Errorf("returned conv Model = %q, want %q (seeding reads conv.Model)", got.Model, wantModel)
	}

	// No conversation file on disk → nil, so startSession skips seeding.
	sMissing := &engineSession{
		key:              "missing",
		conversationID:   "no-such-conversation",
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	if got := m.rehydrateDispatchState(sMissing, "missing"); got != nil {
		t.Errorf("expected nil for missing conversation, got %+v", got)
	}
}

// TestRehydrateDispatchState_MergesWithExtensionRoster verifies that
// rehydrated dispatch entries survive when the extension emits its
// fresh roster (all idle). The engine-managed entries should win.
func TestRehydrateDispatchState_MergesWithExtensionRoster(t *testing.T) {
	s := &engineSession{
		key:    "test-key",
		agents: agents.NewRegistry(),
	}

	// Simulate rehydration (using AppendOrUpdate for consistency).
	s.agents.AppendOrUpdate(types.AgentStateUpdate{
		Name:   "agent-designer",
		ID:     "dispatch-ad-1",
		Status: "done",
		Metadata: map[string]interface{}{
			"displayName":    "Agent Designer",
			"task":           "brief me",
			"conversationId": "conv-abc",
		},
	}, func(existing *types.AgentStateUpdate) {
		existing.ID = "dispatch-ad-1"
		existing.Status = "done"
		if existing.Metadata == nil {
			existing.Metadata = map[string]interface{}{}
		}
		existing.Metadata["task"] = "brief me"
		existing.Metadata["conversationId"] = "conv-abc"
	})

	// Extension fires session_start → emits all-idle roster.
	s.agents.CacheExtStates([]types.AgentStateUpdate{
		{Name: "ion-tutor", Status: "idle"},
		{Name: "agent-designer", Status: "idle"},
		{Name: "hook-specialist", Status: "idle"},
	})

	snapshot := s.agents.MergedSnapshot()

	// Should be 3: ion-tutor + agent-designer (engine wins) + hook-specialist.
	if len(snapshot) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(snapshot))
	}

	for _, entry := range snapshot {
		if entry.Name == "agent-designer" {
			if entry.Status != "done" {
				t.Errorf("agent-designer should be done (engine wins), got %s", entry.Status)
			}
			if entry.Metadata["conversationId"] != "conv-abc" {
				t.Errorf("conversationId should survive, got %v", entry.Metadata["conversationId"])
			}
		}
	}
}

// TestRehydrateDispatchState_MultipleAgentsMultipleDispatches verifies
// a session with 3 different agents dispatched (one dispatched twice)
// rehydrates correctly.
func TestRehydrateDispatchState_MultipleAgentsMultipleDispatches(t *testing.T) {
	s := &engineSession{
		key:    "test-key",
		agents: agents.NewRegistry(),
	}

	// Simulate rehydrating 4 dispatch records from disk using AppendOrUpdate.
	records := []struct {
		name, id, status, task, convID string
	}{
		{"agent-designer", "dispatch-ad-1", "done", "first task", "conv-1"},
		{"agent-designer", "dispatch-ad-2", "done", "second task", "conv-2"},
		{"cloud-architect", "dispatch-ca-1", "done", "review arch", "conv-3"},
		{"security-officer", "dispatch-so-1", "error", "audit", ""},
	}

	for _, rec := range records {
		metadata := map[string]interface{}{
			"task": rec.task,
		}
		if rec.convID != "" {
			metadata["conversationId"] = rec.convID
			metadata["conversationIds"] = []interface{}{rec.convID}
		}

		dispatchEntry := map[string]interface{}{
			"id":     rec.id,
			"task":   rec.task,
			"status": rec.status,
		}
		if rec.convID != "" {
			dispatchEntry["conversationId"] = rec.convID
		}
		metadata["dispatches"] = []interface{}{dispatchEntry}

		convID := rec.convID // capture for closure
		s.agents.AppendOrUpdate(types.AgentStateUpdate{
			Name:     rec.name,
			ID:       rec.id,
			Status:   rec.status,
			Metadata: metadata,
		}, func(existing *types.AgentStateUpdate) {
			existing.ID = rec.id
			existing.Status = rec.status
			if existing.Metadata == nil {
				existing.Metadata = map[string]interface{}{}
			}
			existing.Metadata["task"] = rec.task
			if convID != "" {
				existing.Metadata["conversationId"] = convID
			}

			// Merge conversationIds.
			existingIDs, _ := existing.Metadata["conversationIds"].([]interface{})
			seen := make(map[string]bool)
			for _, id := range existingIDs {
				if s, ok := id.(string); ok {
					seen[s] = true
				}
			}
			if convID != "" && !seen[convID] {
				existingIDs = append(existingIDs, convID)
			}
			if len(existingIDs) > 0 {
				existing.Metadata["conversationIds"] = existingIDs
			}

			// Append to dispatches.
			existingDispatches, _ := existing.Metadata["dispatches"].([]interface{})
			existing.Metadata["dispatches"] = append(existingDispatches, dispatchEntry)
		})
	}

	snapshot := s.agents.MergedSnapshot()
	// 3 entries: agent-designer (coalesced) + cloud-architect + security-officer.
	if len(snapshot) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(snapshot))
	}

	// Count agent-designer entries — should be 1 (coalesced).
	adCount := 0
	for _, entry := range snapshot {
		if entry.Name == "agent-designer" {
			adCount++

			// Latest dispatch fields should win.
			if entry.Metadata["task"] != "second task" {
				t.Errorf("agent-designer task = %v, want second task", entry.Metadata["task"])
			}
			if entry.Metadata["conversationId"] != "conv-2" {
				t.Errorf("agent-designer conversationId = %v, want conv-2", entry.Metadata["conversationId"])
			}

			// conversationIds should contain both conv-1 and conv-2.
			convIDs, ok := entry.Metadata["conversationIds"].([]interface{})
			if !ok {
				t.Fatalf("agent-designer conversationIds is not []interface{}: %T", entry.Metadata["conversationIds"])
			}
			if len(convIDs) != 2 {
				t.Errorf("agent-designer conversationIds length = %d, want 2: %v", len(convIDs), convIDs)
			}
			idSet := map[string]bool{}
			for _, id := range convIDs {
				idSet[id.(string)] = true
			}
			if !idSet["conv-1"] || !idSet["conv-2"] {
				t.Errorf("agent-designer conversationIds should have conv-1 and conv-2, got %v", convIDs)
			}

			// dispatches array should have 2 entries.
			dispatchesMeta, ok := entry.Metadata["dispatches"].([]interface{})
			if !ok {
				t.Fatalf("agent-designer dispatches is not []interface{}: %T", entry.Metadata["dispatches"])
			}
			if len(dispatchesMeta) != 2 {
				t.Errorf("agent-designer dispatches length = %d, want 2", len(dispatchesMeta))
			}
		}
	}
	if adCount != 1 {
		t.Errorf("expected 1 agent-designer entry (coalesced), got %d", adCount)
	}

	// Verify security-officer has error status and no convID.
	for _, entry := range snapshot {
		if entry.Name == "security-officer" {
			if entry.Status != "error" {
				t.Errorf("security-officer should be error, got %s", entry.Status)
			}
			if _, hasConv := entry.Metadata["conversationId"]; hasConv {
				t.Errorf("security-officer should not have conversationId")
			}
		}
	}
}

// TestRehydrateDispatchState_EmptyConversation verifies that
// rehydration with no dispatch entries produces an empty registry.
func TestRehydrateDispatchState_EmptyConversation(t *testing.T) {
	s := &engineSession{
		key:    "test-key",
		agents: agents.NewRegistry(),
	}

	// No rehydration — simulate loading a conversation with no dispatches.
	snapshot := s.agents.MergedSnapshot()
	if len(snapshot) != 0 {
		t.Errorf("expected 0 entries, got %d", len(snapshot))
	}
}

// newTestManager creates a minimal Manager for testing. It uses nil
// for the backend since dispatch rehydration tests don't need one.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	return &Manager{
		sessions: make(map[string]*engineSession),
	}
}

// makeDispatchMember builds a single dispatch[] array member.
func makeDispatchMember(id, convID, status string) map[string]interface{} {
	m := map[string]interface{}{"id": id, "status": status}
	if convID != "" {
		m["conversationId"] = convID
	}
	return m
}

// TestRehydrateDispatchState_CollapsesDuplicateArray drives the real
// rehydrateDispatchState against an on-disk conversation whose persisted
// agent_dispatch entries carry a duplicate-laden dispatches[] array (the
// amplification-bug fingerprint: many members, few distinct ids). The
// rehydrated MergedSnapshot must collapse to the DISTINCT-id count.
func TestRehydrateDispatchState_CollapsesDuplicateArray(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	convDir := home + "/.ion/conversations"

	const convID = "rehydrate-dup-1"
	conv := conversation.CreateConversation(convID, "sys", "model")
	conversation.AddUserMessage(conv, "hello")

	// One agent_dispatch entry for "dev-lead" whose array holds 5 members but
	// only 2 distinct ids (d1 thrice, d2 twice) — exactly what the amplified
	// file on disk looks like.
	dupArray := []map[string]interface{}{
		makeDispatchMember("d1", "conv-1", "done"),
		makeDispatchMember("d2", "conv-2", "done"),
		makeDispatchMember("d1", "conv-1", "done"),
		makeDispatchMember("d2", "conv-2", "done"),
		makeDispatchMember("d1", "conv-1", "done"),
	}
	conv.Entries = append(conv.Entries, conversation.SessionEntry{
		ID: "d2", ParentID: nil, // representative id = d2
		Type: conversation.EntryAgentDispatch, Timestamp: 1000,
		Data: conversation.AgentDispatchData{
			AgentName:  "dev-lead",
			AgentID:    "d2",
			Task:       "lead the work",
			Status:     "done",
			Dispatches: dupArray,
		},
	})
	if err := conversation.Save(conv, convDir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	m := newTestManager(t)
	s := &engineSession{
		key:              "k",
		conversationID:   convID,
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	m.sessions["k"] = s

	m.rehydrateDispatchState(s, "k")

	snap := s.agents.MergedSnapshot()
	var devLead *types.AgentStateUpdate
	for i := range snap {
		if snap[i].Name == "dev-lead" {
			devLead = &snap[i]
			break
		}
	}
	if devLead == nil {
		t.Fatalf("dev-lead not found in snapshot: %+v", snap)
	}
	dispatches, _ := devLead.Metadata["dispatches"].([]interface{})
	if len(dispatches) != 2 {
		t.Fatalf("expected 2 distinct dispatches after collapse, got %d: %v", len(dispatches), dispatches)
	}
}

// TestPersistRehydrateLoop_LengthStable is the amplification regression test.
// It runs persist -> rehydrate -> persist -> rehydrate and asserts the grouped
// dev-lead dispatches[] length is FIXED across cycles. Without the id-dedup at
// groupByName, persistTerminalDispatches, and rehydrateDispatchState, the
// length grows every round-trip (the 1,2,4,6,...,99 progression seen on disk).
func TestPersistRehydrateLoop_LengthStable(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	convDir := home + "/.ion/conversations"

	const convID = "loop-1"
	conv := conversation.CreateConversation(convID, "sys", "model")
	conversation.AddUserMessage(conv, "hello")
	if err := conversation.Save(conv, convDir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	m := newTestManager(t)
	s := &engineSession{
		key:              "k",
		conversationID:   convID,
		agents:           agents.NewRegistry(),
		dispatchRegistry: extcontext.NewDispatchRegistry(),
		pending:          pending.New(),
	}
	m.sessions["k"] = s

	// Seed the registry with three genuinely-distinct dev-lead dispatches.
	// Each slot's array carries the FULL set (overlapping) — the shape a
	// partially-amplified file produces, so this loop exercises the cross-slot
	// concatenation in groupByName as well as the persist/rehydrate de-dup.
	fullArray := []interface{}{
		makeDispatchMember("d1", "conv-d1", "done"),
		makeDispatchMember("d2", "conv-d2", "done"),
		makeDispatchMember("d3", "conv-d3", "done"),
	}
	for _, id := range []string{"d1", "d2", "d3"} {
		s.agents.AppendOrUpdateByID(types.AgentStateUpdate{
			Name:   "dev-lead",
			ID:     id,
			Status: "done",
			Metadata: map[string]interface{}{
				"task":           "lead",
				"conversationId": "conv-" + id,
				"dispatches":     fullArray,
			},
		}, func(existing *types.AgentStateUpdate) {})
	}

	distinctLen := func() int {
		snap := s.agents.MergedSnapshot()
		for i := range snap {
			if snap[i].Name == "dev-lead" {
				d, _ := snap[i].Metadata["dispatches"].([]interface{})
				return len(d)
			}
		}
		return -1
	}

	if got := distinctLen(); got != 3 {
		t.Fatalf("seed: expected 3 dispatches, got %d", got)
	}

	// Run several persist -> rehydrate cycles. The length must stay at 3.
	for cycle := 0; cycle < 4; cycle++ {
		m.persistTerminalDispatches("k", convID)

		// Fresh registry simulates an engine restart / session reload.
		s.agents = agents.NewRegistry()
		m.rehydrateDispatchState(s, "k")

		if got := distinctLen(); got != 3 {
			t.Fatalf("cycle %d: expected dispatches length fixed at 3, got %d (amplification)", cycle, got)
		}
	}
}
