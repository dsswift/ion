//go:build integration

package integration

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestConversationJSONLRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := conversation.CreateConversation("roundtrip-test", "You are helpful.", "test-model")
	conversation.AddUserMessage(conv, "Hello")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "Hi there!"},
	}, types.LlmUsage{InputTokens: 10, OutputTokens: 5})
	conversation.AddUserMessage(conv, "How are you?")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
		{Type: "text", Text: "I'm doing well."},
	}, types.LlmUsage{InputTokens: 20, OutputTokens: 8})

	// Save
	if err := conversation.Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Verify file exists
	jsonlPath := filepath.Join(dir, "roundtrip-test.jsonl")
	if _, err := os.Stat(jsonlPath); err != nil {
		t.Fatalf("JSONL file not created: %v", err)
	}

	// Load
	loaded, err := conversation.Load("roundtrip-test", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Verify fields
	if loaded.ID != "roundtrip-test" {
		t.Errorf("ID: got %q, want %q", loaded.ID, "roundtrip-test")
	}
	if loaded.System != "You are helpful." {
		t.Errorf("System: got %q", loaded.System)
	}
	if loaded.Model != "test-model" {
		t.Errorf("Model: got %q", loaded.Model)
	}
	if loaded.TotalInputTokens != 30 {
		t.Errorf("TotalInputTokens: got %d, want 30", loaded.TotalInputTokens)
	}
	if loaded.TotalOutputTokens != 13 {
		t.Errorf("TotalOutputTokens: got %d, want 13", loaded.TotalOutputTokens)
	}

	// Verify messages were rebuilt from entries
	if len(loaded.Messages) != 4 {
		t.Fatalf("Messages: got %d, want 4", len(loaded.Messages))
	}
	if loaded.Messages[0].Role != "user" {
		t.Errorf("Message[0].Role: got %q, want 'user'", loaded.Messages[0].Role)
	}
	if loaded.Messages[1].Role != "assistant" {
		t.Errorf("Message[1].Role: got %q, want 'assistant'", loaded.Messages[1].Role)
	}

	// Verify entries
	if len(loaded.Entries) != 4 {
		t.Errorf("Entries: got %d, want 4", len(loaded.Entries))
	}
	if loaded.LeafID == nil {
		t.Error("LeafID should not be nil")
	}
}

func TestConversationTreeBranching(t *testing.T) {
	conv := conversation.CreateConversation("branch-test", "system", "model")

	// Add 5 messages
	conversation.AddUserMessage(conv, "msg-1")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "reply-1"}}, types.LlmUsage{})
	conversation.AddUserMessage(conv, "msg-2")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "reply-2"}}, types.LlmUsage{})
	conversation.AddUserMessage(conv, "msg-3")

	if len(conv.Entries) != 5 {
		t.Fatalf("expected 5 entries, got %d", len(conv.Entries))
	}

	// Branch at entry 3 (0-indexed: entries[2])
	branchEntryID := conv.Entries[2].ID
	msgs, err := conversation.Branch(conv, branchEntryID)
	if err != nil {
		t.Fatalf("Branch: %v", err)
	}

	// Messages should be truncated to the branch point (3 entries: msg-1, reply-1, msg-2)
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages after branch, got %d", len(msgs))
	}

	// Add 2 more messages on the new branch
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "branch-reply-1"}}, types.LlmUsage{})
	conversation.AddUserMessage(conv, "branch-msg-2")

	// Total entries should be 7 (5 original + 2 new)
	if len(conv.Entries) != 7 {
		t.Errorf("expected 7 entries after branching, got %d", len(conv.Entries))
	}

	// Get branch points - entry 2 should be a branch point (2 children)
	branchPoints := conversation.GetBranchPoints(conv)
	if len(branchPoints) != 1 {
		t.Errorf("expected 1 branch point, got %d", len(branchPoints))
	}
	if len(branchPoints) > 0 && branchPoints[0].ID != branchEntryID {
		t.Errorf("branch point ID: got %q, want %q", branchPoints[0].ID, branchEntryID)
	}

	// Get leaves - should be 2 (end of each branch)
	leaves := conversation.GetLeaves(conv)
	if len(leaves) != 2 {
		t.Errorf("expected 2 leaves, got %d", len(leaves))
	}
}

func TestConversationMigrationV1ToV2(t *testing.T) {
	dir := t.TempDir()

	// Write a v1 JSON conversation (no entries, no version)
	v1Conv := map[string]interface{}{
		"id":      "migrate-test",
		"system":  "You are helpful.",
		"model":   "test-model",
		"messages": []interface{}{
			map[string]interface{}{"role": "user", "content": "Hello"},
			map[string]interface{}{"role": "assistant", "content": "Hi!"},
			map[string]interface{}{"role": "user", "content": "Bye"},
		},
		"totalInputTokens":  0,
		"totalOutputTokens": 0,
		"totalCost":         0,
		"createdAt":         1700000000000,
	}

	data, err := json.MarshalIndent(v1Conv, "", "  ")
	if err != nil {
		t.Fatalf("marshal v1: %v", err)
	}
	jsonPath := filepath.Join(dir, "migrate-test.json")
	if err := os.WriteFile(jsonPath, data, 0644); err != nil {
		t.Fatalf("write v1: %v", err)
	}

	// Load (should trigger migration)
	loaded, err := conversation.Load("migrate-test", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	// Verify migration
	if loaded.Version != 2 {
		t.Errorf("Version: got %d, want 2", loaded.Version)
	}
	if len(loaded.Entries) != 3 {
		t.Errorf("Entries: got %d, want 3", len(loaded.Entries))
	}
	if loaded.LeafID == nil {
		t.Error("LeafID should be set after migration")
	}

	// Messages should be rebuilt
	if len(loaded.Messages) != 3 {
		t.Errorf("Messages: got %d, want 3", len(loaded.Messages))
	}

	// Verify entry chain
	for i, entry := range loaded.Entries {
		if i == 0 {
			if entry.ParentID != nil {
				t.Error("first entry should have nil ParentID")
			}
		} else {
			if entry.ParentID == nil {
				t.Errorf("entry %d should have non-nil ParentID", i)
			} else if *entry.ParentID != loaded.Entries[i-1].ID {
				t.Errorf("entry %d ParentID mismatch", i)
			}
		}
	}
}

func TestConversationCompaction(t *testing.T) {
	conv := conversation.CreateConversation("compact-test", "system", "model")

	// Add 30 messages (15 user + 15 assistant pairs)
	for i := 0; i < 15; i++ {
		conversation.AddUserMessage(conv, "user message with some content to make it longer than 100 chars for micro-compaction testing purposes in the tool result blocks")
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{
			{Type: "text", Text: "assistant reply"},
		}, types.LlmUsage{InputTokens: 10, OutputTokens: 5})
	}

	if len(conv.Messages) != 30 {
		t.Fatalf("expected 30 messages, got %d", len(conv.Messages))
	}

	// Compact to keep 10 pairs
	conversation.Compact(conv, 10)

	if len(conv.Messages) >= 30 {
		t.Errorf("expected fewer than 30 messages after compaction, got %d", len(conv.Messages))
	}

	// Test MicroCompact
	conv2 := conversation.CreateConversation("micro-test", "system", "model")

	// Add some tool_result messages
	for i := 0; i < 20; i++ {
		conversation.AddUserMessage(conv2, "question")
		// Add a tool_use from assistant
		conversation.AddAssistantMessage(conv2, []types.LlmContentBlock{
			{Type: "tool_use", ID: "tool_" + conversation.GenEntryID(), Name: "Read"},
		}, types.LlmUsage{})
		// Add tool_result as user message
		isErr := false
		longContent := "This is a very long tool result content that exceeds 100 characters and should be cleared by micro-compaction to save context window space for more important things."
		conv2.Messages = append(conv2.Messages, types.LlmMessage{
			Role: "user",
			Content: []types.LlmContentBlock{
				{Type: "tool_result", ToolUseID: "tool_test", Content: longContent, IsError: &isErr},
			},
		})
	}

	cleared := conversation.MicroCompact(conv2, 5)
	if cleared == 0 {
		t.Error("expected MicroCompact to clear some tool_result blocks")
	}
}

func TestConversationGetTree(t *testing.T) {
	conv := conversation.CreateConversation("tree-test", "system", "model")

	conversation.AddUserMessage(conv, "root")
	conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "reply"}}, types.LlmUsage{})

	tree := conversation.GetTree(conv)
	if tree == nil {
		t.Fatal("tree should not be nil")
	}
	if len(tree) != 1 {
		t.Errorf("expected 1 root node, got %d", len(tree))
	}
	if len(tree) > 0 && len(tree[0].Children) != 1 {
		t.Errorf("expected 1 child of root, got %d", len(tree[0].Children))
	}
}

func TestConversationEstimateTokens(t *testing.T) {
	tests := []struct {
		name    string
		content interface{}
		minTok  int
	}{
		{"short string", "hello", 1},
		{"medium string", "the quick brown fox jumps over the lazy dog", 5},
		{"empty string", "", 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tokens := conversation.EstimateTokens(tt.content)
			if tokens < tt.minTok {
				t.Errorf("EstimateTokens(%q) = %d, want >= %d", tt.content, tokens, tt.minTok)
			}
		})
	}
}
