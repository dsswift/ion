package conversation

// conversation_dispatch_test.go — persistence round-trip tests for
// agent_dispatch entries in the conversation tree file.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestAgentDispatchEntry_WriteAndRead writes an agent_dispatch entry,
// reloads the conversation, and verifies all fields survive the
// round-trip.
func TestAgentDispatchEntry_WriteAndRead(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("dispatch-rt", "system", "claude-sonnet-4-6")

	// Add a regular message so Entries is non-empty (triggers split save).
	AddUserMessage(conv, "hello")

	// Append an agent_dispatch entry (standalone, not chained to leaf).
	dispatch := AgentDispatchData{
		AgentName:       "agent-designer",
		AgentID:         "dispatch-agent-designer-1780108274307",
		DisplayName:     "Agent Designer",
		Task:            "brief me on agent design",
		Model:           "claude-sonnet-4-6",
		Status:          "done",
		Elapsed:         32.5,
		ConversationID:  "1780108280000-abc123",
		ConversationIDs: []string{"1780108280000-abc123"},
	}
	entry := SessionEntry{
		ID:        dispatch.AgentID,
		ParentID:  nil,
		Type:      EntryAgentDispatch,
		Timestamp: nowMillis(),
		Data:      dispatch,
	}
	conv.Entries = append(conv.Entries, entry)

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("dispatch-rt", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	dispatches := AgentDispatchEntries(loaded)
	if len(dispatches) != 1 {
		t.Fatalf("expected 1 dispatch entry, got %d", len(dispatches))
	}

	d := dispatches[0]
	if d.AgentName != "agent-designer" {
		t.Errorf("AgentName = %q, want %q", d.AgentName, "agent-designer")
	}
	if d.AgentID != "dispatch-agent-designer-1780108274307" {
		t.Errorf("AgentID = %q, want %q", d.AgentID, "dispatch-agent-designer-1780108274307")
	}
	if d.DisplayName != "Agent Designer" {
		t.Errorf("DisplayName = %q, want %q", d.DisplayName, "Agent Designer")
	}
	if d.Task != "brief me on agent design" {
		t.Errorf("Task = %q, want %q", d.Task, "brief me on agent design")
	}
	if d.Model != "claude-sonnet-4-6" {
		t.Errorf("Model = %q, want %q", d.Model, "claude-sonnet-4-6")
	}
	if d.Status != "done" {
		t.Errorf("Status = %q, want %q", d.Status, "done")
	}
	if d.Elapsed != 32.5 {
		t.Errorf("Elapsed = %f, want %f", d.Elapsed, 32.5)
	}
	if d.ConversationID != "1780108280000-abc123" {
		t.Errorf("ConversationID = %q, want %q", d.ConversationID, "1780108280000-abc123")
	}
	if len(d.ConversationIDs) != 1 || d.ConversationIDs[0] != "1780108280000-abc123" {
		t.Errorf("ConversationIDs = %v, want [1780108280000-abc123]", d.ConversationIDs)
	}
}

// TestAgentDispatchEntry_MultipleDispatches writes 3 dispatch entries
// for different agents, reloads, and verifies all are present and
// distinguishable.
func TestAgentDispatchEntry_MultipleDispatches(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("multi-dispatch", "sys", "model")
	AddUserMessage(conv, "go")

	agents := []AgentDispatchData{
		{AgentName: "agent-a", AgentID: "dispatch-a-1", Status: "done", Task: "task-a", ConversationID: "conv-a"},
		{AgentName: "agent-b", AgentID: "dispatch-b-2", Status: "error", Task: "task-b"},
		{AgentName: "agent-c", AgentID: "dispatch-c-3", Status: "cancelled", Task: "task-c"},
	}

	for _, a := range agents {
		conv.Entries = append(conv.Entries, SessionEntry{
			ID:        a.AgentID,
			ParentID:  nil,
			Type:      EntryAgentDispatch,
			Timestamp: nowMillis(),
			Data:      a,
		})
	}

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("multi-dispatch", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	dispatches := AgentDispatchEntries(loaded)
	if len(dispatches) != 3 {
		t.Fatalf("expected 3 dispatch entries, got %d", len(dispatches))
	}

	// Verify ordering matches write order.
	names := []string{dispatches[0].AgentName, dispatches[1].AgentName, dispatches[2].AgentName}
	want := []string{"agent-a", "agent-b", "agent-c"}
	for i := range names {
		if names[i] != want[i] {
			t.Errorf("dispatch[%d].AgentName = %q, want %q", i, names[i], want[i])
		}
	}

	// Verify statuses are preserved.
	if dispatches[0].Status != "done" {
		t.Errorf("agent-a status = %q, want done", dispatches[0].Status)
	}
	if dispatches[1].Status != "error" {
		t.Errorf("agent-b status = %q, want error", dispatches[1].Status)
	}
	if dispatches[2].Status != "cancelled" {
		t.Errorf("agent-c status = %q, want cancelled", dispatches[2].Status)
	}
}

// TestAgentDispatchEntry_ReDispatchSameAgent writes 2 dispatch entries
// for the same agent name (simulating re-dispatch). Both should be
// preserved with their respective conversationIds.
func TestAgentDispatchEntry_ReDispatchSameAgent(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("re-dispatch", "sys", "model")
	AddUserMessage(conv, "go")

	conv.Entries = append(conv.Entries,
		SessionEntry{
			ID: "dispatch-ad-1", ParentID: nil,
			Type: EntryAgentDispatch, Timestamp: 1000,
			Data: AgentDispatchData{
				AgentName: "agent-designer", AgentID: "dispatch-ad-1",
				Status: "done", ConversationID: "conv-1",
				ConversationIDs: []string{"conv-1"},
			},
		},
		SessionEntry{
			ID: "dispatch-ad-2", ParentID: nil,
			Type: EntryAgentDispatch, Timestamp: 2000,
			Data: AgentDispatchData{
				AgentName: "agent-designer", AgentID: "dispatch-ad-2",
				Status: "done", ConversationID: "conv-2",
				ConversationIDs: []string{"conv-2"},
			},
		},
	)

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("re-dispatch", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	dispatches := AgentDispatchEntries(loaded)
	if len(dispatches) != 2 {
		t.Fatalf("expected 2 dispatch entries, got %d", len(dispatches))
	}

	if dispatches[0].ConversationID != "conv-1" {
		t.Errorf("first dispatch convId = %q, want conv-1", dispatches[0].ConversationID)
	}
	if dispatches[1].ConversationID != "conv-2" {
		t.Errorf("second dispatch convId = %q, want conv-2", dispatches[1].ConversationID)
	}
}

// TestAgentDispatchEntry_EmptyConversation verifies that loading a
// conversation with no dispatch entries returns zero records.
func TestAgentDispatchEntry_EmptyConversation(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("no-dispatch", "sys", "model")
	AddUserMessage(conv, "hello")

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("no-dispatch", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	dispatches := AgentDispatchEntries(loaded)
	if len(dispatches) != 0 {
		t.Errorf("expected 0 dispatch entries, got %d", len(dispatches))
	}
}

// TestAgentDispatchEntry_CorruptedEntry verifies that a malformed
// dispatch entry is skipped gracefully without crashing, and other
// valid entries still load.
func TestAgentDispatchEntry_CorruptedEntry(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("corrupt-dispatch", "sys", "model")
	AddUserMessage(conv, "hello")

	// Add a valid dispatch entry.
	conv.Entries = append(conv.Entries, SessionEntry{
		ID: "dispatch-valid", ParentID: nil,
		Type: EntryAgentDispatch, Timestamp: 1000,
		Data: AgentDispatchData{
			AgentName: "good-agent", AgentID: "dispatch-valid",
			Status: "done", Task: "valid task",
		},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Now manually corrupt the tree file by inserting a malformed entry.
	treePath := filepath.Join(dir, "corrupt-dispatch.tree.jsonl")
	data, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatalf("read tree: %v", err)
	}

	// Append a corrupted agent_dispatch line (invalid JSON in data field).
	corrupted := string(data) + `{"id":"bad","parentId":null,"type":"agent_dispatch","timestamp":999,"data":"not-a-map"}` + "\n"
	if err := os.WriteFile(treePath, []byte(corrupted), 0o644); err != nil {
		t.Fatalf("write corrupted tree: %v", err)
	}

	loaded, err := Load("corrupt-dispatch", dir)
	if err != nil {
		t.Fatalf("Load should not fail on corrupted entry: %v", err)
	}

	// The valid dispatch entry should still load.
	dispatches := AgentDispatchEntries(loaded)
	if len(dispatches) != 1 {
		t.Fatalf("expected 1 valid dispatch entry (corrupted skipped), got %d", len(dispatches))
	}
	if dispatches[0].AgentName != "good-agent" {
		t.Errorf("expected good-agent, got %q", dispatches[0].AgentName)
	}
}

// TestAgentDispatchEntry_DoesNotAffectContextPath verifies that
// dispatch entries with nil parentId do not appear in
// BuildContextPath output (they are standalone metadata, not messages).
func TestAgentDispatchEntry_DoesNotAffectContextPath(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("ctx-path", "sys", "model")
	AddUserMessage(conv, "hello")

	// Append a dispatch entry (nil parentId).
	conv.Entries = append(conv.Entries, SessionEntry{
		ID: "dispatch-1", ParentID: nil,
		Type: EntryAgentDispatch, Timestamp: nowMillis(),
		Data: AgentDispatchData{
			AgentName: "agent-a", AgentID: "dispatch-1",
			Status: "done", Task: "do stuff",
		},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("ctx-path", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// BuildContextPath should only contain the user message, not the dispatch.
	msgs := BuildContextPath(loaded)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message in context path, got %d", len(msgs))
	}
	if msgs[0].Role != "user" {
		t.Errorf("expected user message, got role=%q", msgs[0].Role)
	}
}

// TestAgentDispatchEntry_TreeFileContainsEntry verifies the raw
// .tree.jsonl file contains the agent_dispatch entry with the
// correct JSON shape.
func TestAgentDispatchEntry_TreeFileContainsEntry(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("raw-tree", "sys", "model")
	AddUserMessage(conv, "hello")

	conv.Entries = append(conv.Entries, SessionEntry{
		ID: "dispatch-raw", ParentID: nil,
		Type: EntryAgentDispatch, Timestamp: 1234567890,
		Data: AgentDispatchData{
			AgentName:      "test-agent",
			AgentID:        "dispatch-raw",
			Status:         "done",
			ConversationID: "conv-xyz",
		},
	})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	treePath := filepath.Join(dir, "raw-tree.tree.jsonl")
	data, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatalf("read tree: %v", err)
	}

	// Parse each line and look for the dispatch entry.
	lines, err := scanNonEmptyLines(data)
	if err != nil {
		t.Fatalf("scan: %v", err)
	}

	found := false
	for _, line := range lines {
		var raw map[string]interface{}
		if json.Unmarshal([]byte(line), &raw) != nil {
			continue
		}
		if raw["type"] == "agent_dispatch" {
			found = true
			// Verify nested data shape.
			dataMap, ok := raw["data"].(map[string]interface{})
			if !ok {
				t.Fatal("data field should be an object")
			}
			if dataMap["agentName"] != "test-agent" {
				t.Errorf("agentName = %v, want test-agent", dataMap["agentName"])
			}
			if dataMap["conversationId"] != "conv-xyz" {
				t.Errorf("conversationId = %v, want conv-xyz", dataMap["conversationId"])
			}
		}
	}
	if !found {
		t.Error("agent_dispatch entry not found in tree file")
	}
}
