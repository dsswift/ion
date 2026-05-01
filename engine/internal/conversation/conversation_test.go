package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestGenEntryID(t *testing.T) {
	id := GenEntryID()
	if len(id) != 8 {
		t.Errorf("expected 8 chars, got %d: %q", len(id), id)
	}
	for _, c := range id {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			t.Errorf("non-hex char in ID: %c", c)
		}
	}
	id2 := GenEntryID()
	if id == id2 {
		t.Error("two generated IDs are identical")
	}
}

func TestCreateConversation(t *testing.T) {
	conv := CreateConversation("test-1", "you are helpful", "claude-3")

	if conv.ID != "test-1" {
		t.Errorf("ID = %q, want %q", conv.ID, "test-1")
	}
	if conv.System != "you are helpful" {
		t.Errorf("System = %q", conv.System)
	}
	if conv.Model != "claude-3" {
		t.Errorf("Model = %q", conv.Model)
	}
	if conv.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d", conv.Version, CurrentVersion)
	}
	if len(conv.Messages) != 0 {
		t.Errorf("Messages should be empty, got %d", len(conv.Messages))
	}
	if len(conv.Entries) != 0 {
		t.Errorf("Entries should be empty, got %d", len(conv.Entries))
	}
	if conv.LeafID != nil {
		t.Errorf("LeafID should be nil")
	}
	if conv.CreatedAt == 0 {
		t.Error("CreatedAt should be set")
	}
}

func TestAddMessages(t *testing.T) {
	conv := CreateConversation("msg-test", "", "claude-3")

	AddUserMessage(conv, "hello")
	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(conv.Messages))
	}
	if conv.Messages[0].Role != "user" {
		t.Errorf("role = %q, want user", conv.Messages[0].Role)
	}
	if len(conv.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(conv.Entries))
	}

	blocks := []types.LlmContentBlock{{Type: "text", Text: "hi there"}}
	usage := types.LlmUsage{InputTokens: 10, OutputTokens: 20}
	AddAssistantMessage(conv, blocks, usage)

	if len(conv.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(conv.Messages))
	}
	if conv.TotalInputTokens != 10 {
		t.Errorf("TotalInputTokens = %d, want 10", conv.TotalInputTokens)
	}
	if conv.TotalOutputTokens != 20 {
		t.Errorf("TotalOutputTokens = %d, want 20", conv.TotalOutputTokens)
	}
	if len(conv.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(conv.Entries))
	}

	// Entries should be chained
	if conv.Entries[1].ParentID == nil || *conv.Entries[1].ParentID != conv.Entries[0].ID {
		t.Error("second entry should point to first as parent")
	}
	if conv.LeafID == nil || *conv.LeafID != conv.Entries[1].ID {
		t.Error("leafID should point to last entry")
	}
}

func TestAddToolResults(t *testing.T) {
	conv := CreateConversation("tool-test", "", "claude-3")

	AddToolResults(conv, []ToolResultEntry{
		{ToolUseID: "tu_1", Content: "result content", IsError: false},
	})

	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(conv.Messages))
	}
	if conv.Messages[0].Role != "user" {
		t.Errorf("role = %q, want user", conv.Messages[0].Role)
	}

	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected []LlmContentBlock content")
	}
	if blocks[0].Type != "tool_result" {
		t.Errorf("block type = %q, want tool_result", blocks[0].Type)
	}
	if blocks[0].ToolUseID != "tu_1" {
		t.Errorf("tool_use_id = %q, want tu_1", blocks[0].ToolUseID)
	}
}

func TestUpdateCost(t *testing.T) {
	conv := CreateConversation("cost-test", "", "claude-3")
	UpdateCost(conv, 0.05)
	UpdateCost(conv, 0.10)
	if conv.TotalCost < 0.149 || conv.TotalCost > 0.151 {
		t.Errorf("TotalCost = %f, want ~0.15", conv.TotalCost)
	}
}

func TestAppendEntry(t *testing.T) {
	conv := CreateConversation("entry-test", "", "claude-3")

	e1 := AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: "hello"})
	if e1.ParentID != nil {
		t.Error("first entry should have nil parent")
	}

	e2 := AppendEntry(conv, EntryMessage, MessageData{Role: "assistant", Content: "hi"})
	if e2.ParentID == nil || *e2.ParentID != e1.ID {
		t.Error("second entry parent should be first entry")
	}
	if conv.LeafID == nil || *conv.LeafID != e2.ID {
		t.Error("leaf should point to last appended entry")
	}
}

func TestAppendEntry_ModelChange(t *testing.T) {
	conv := CreateConversation("model-change", "", "claude-3")

	entry := AppendEntry(conv, EntryModelChange, ModelChangeData{
		Model:         "claude-opus-4-20250514",
		PreviousModel: "claude-sonnet-4-20250514",
	})

	if entry.Type != EntryModelChange {
		t.Fatalf("expected model_change, got %q", entry.Type)
	}
}

func TestAppendEntry_Label(t *testing.T) {
	conv := CreateConversation("label-test", "", "claude-3")
	AddUserMessage(conv, "important")
	targetID := conv.Entries[0].ID

	label := "checkpoint"
	entry := AppendEntry(conv, EntryLabel, LabelData{
		TargetID: targetID,
		Label:    &label,
	})

	if entry.Type != EntryLabel {
		t.Fatalf("expected label, got %q", entry.Type)
	}
}

func TestAppendEntry_Custom(t *testing.T) {
	conv := CreateConversation("custom-entry", "", "claude-3")

	entry := AppendEntry(conv, EntryCustom, map[string]interface{}{
		"key": "value",
	})

	if entry.Type != EntryCustom {
		t.Fatalf("expected custom, got %q", entry.Type)
	}
}

// --- GenEntryID uniqueness ---

func TestGenEntryID_Uniqueness(t *testing.T) {
	ids := make(map[string]bool)
	for i := 0; i < 1000; i++ {
		id := GenEntryID()
		if ids[id] {
			t.Fatalf("duplicate ID generated: %q", id)
		}
		ids[id] = true
	}
}

// --- Save to non-existent directory ---

func TestAddToolResults_AppendsEntry(t *testing.T) {
	conv := CreateConversation("tool-entry", "", "claude-3")

	AddToolResults(conv, []ToolResultEntry{
		{ToolUseID: "tu_1", Content: "result"},
	})

	if len(conv.Entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(conv.Entries))
	}
	if conv.Entries[0].Type != EntryMessage {
		t.Fatalf("expected message entry type, got %q", conv.Entries[0].Type)
	}
}

// --- Backward compatibility: v1 JSON load ---
