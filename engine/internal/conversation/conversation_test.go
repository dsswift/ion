package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

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

func TestBuildContextPath(t *testing.T) {
	conv := CreateConversation("ctx-test", "", "claude-3")

	AddUserMessage(conv, "first")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "response 1"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})
	AddUserMessage(conv, "second")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "response 2"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})

	msgs := BuildContextPath(conv)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages in context path, got %d", len(msgs))
	}
	if msgs[0].Role != "user" {
		t.Errorf("first message role = %q, want user", msgs[0].Role)
	}
	if msgs[3].Role != "assistant" {
		t.Errorf("last message role = %q, want assistant", msgs[3].Role)
	}
}

func TestBranch(t *testing.T) {
	conv := CreateConversation("branch-test", "", "claude-3")

	AddUserMessage(conv, "hello")
	firstEntryID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})

	msgs, err := Branch(conv, firstEntryID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message after branch, got %d", len(msgs))
	}

	AddUserMessage(conv, "alternative")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "alt response"}}, types.LlmUsage{InputTokens: 3, OutputTokens: 3})

	bp := GetBranchPoints(conv)
	if len(bp) != 1 {
		t.Fatalf("expected 1 branch point, got %d", len(bp))
	}
	if bp[0].ID != firstEntryID {
		t.Errorf("branch point ID = %q, want %q", bp[0].ID, firstEntryID)
	}
}

func TestBranchNotFound(t *testing.T) {
	conv := CreateConversation("err-test", "", "claude-3")
	AddUserMessage(conv, "hello")

	_, err := Branch(conv, "nonexistent")
	if err == nil {
		t.Error("expected error for nonexistent entry")
	}
}

func TestGetTree(t *testing.T) {
	conv := CreateConversation("tree-test", "", "claude-3")

	AddUserMessage(conv, "root")
	rootID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "r1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "r2"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	tree := GetTree(conv)
	if len(tree) != 1 {
		t.Fatalf("expected 1 root, got %d", len(tree))
	}
	if len(tree[0].Children) != 2 {
		t.Fatalf("root should have 2 children, got %d", len(tree[0].Children))
	}
}

func TestGetLeaves(t *testing.T) {
	conv := CreateConversation("leaf-test", "", "claude-3")

	AddUserMessage(conv, "start")
	startID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "a"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	Branch(conv, startID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "b"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	leaves := GetLeaves(conv)
	if len(leaves) != 2 {
		t.Fatalf("expected 2 leaves, got %d", len(leaves))
	}
}

func TestEstimateTokens(t *testing.T) {
	tests := []struct {
		name    string
		content any
		wantMin int
		wantMax int
	}{
		{
			name:    "short string",
			content: "hello",
			wantMin: 1,
			wantMax: 5,
		},
		{
			name:    "longer string",
			content: "The quick brown fox jumps over the lazy dog.",
			wantMin: 5,
			wantMax: 20,
		},
		{
			name:    "content blocks",
			content: []types.LlmContentBlock{{Type: "text", Text: "hello world"}},
			wantMin: 5,
			wantMax: 30,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EstimateTokens(tt.content)
			if got < tt.wantMin || got > tt.wantMax {
				t.Errorf("EstimateTokens = %d, want [%d, %d]", got, tt.wantMin, tt.wantMax)
			}
		})
	}
}

func TestGetContextUsage(t *testing.T) {
	t.Run("reported tokens", func(t *testing.T) {
		conv := CreateConversation("cu-1", "", "claude-3")
		conv.TotalInputTokens = 50000
		conv.TotalOutputTokens = 10000

		info := GetContextUsage(conv, 200000)
		if info.Estimated {
			t.Error("should not be estimated when tokens are reported")
		}
		if info.Tokens != 60000 {
			t.Errorf("Tokens = %d, want 60000", info.Tokens)
		}
		if info.Percent != 30 {
			t.Errorf("Percent = %d, want 30", info.Percent)
		}
		if info.Limit != 200000 {
			t.Errorf("Limit = %d", info.Limit)
		}
	})

	t.Run("estimated tokens", func(t *testing.T) {
		conv := CreateConversation("cu-2", "", "claude-3")
		AddUserMessage(conv, "hello world this is a test message")
		info := GetContextUsage(conv, 0)
		if !info.Estimated {
			t.Error("should be estimated when no reported tokens")
		}
		if info.Limit != DefaultContext {
			t.Errorf("Limit = %d, want %d", info.Limit, DefaultContext)
		}
	})
}

func TestCompact(t *testing.T) {
	conv := CreateConversation("compact-test", "", "claude-3")

	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 3)
	// Should keep from the user message where pairs==3 to the end
	if len(conv.Messages) > 7 {
		t.Errorf("expected at most 7 messages after compact(3), got %d", len(conv.Messages))
	}
	if len(conv.Messages) < 5 {
		t.Errorf("expected at least 5 messages after compact(3), got %d", len(conv.Messages))
	}
}

func TestCompactNoOp(t *testing.T) {
	conv := CreateConversation("compact-noop", "", "claude-3")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "hello"})

	Compact(conv, 10)
	if len(conv.Messages) != 2 {
		t.Errorf("expected 2 messages (no compaction needed), got %d", len(conv.Messages))
	}
}

func TestMicroCompact(t *testing.T) {
	conv := CreateConversation("micro-test", "", "claude-3")

	longContent := strings.Repeat("x", 200)

	// Old turn with long tool result
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn (should not be cleared)
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_2", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "also done"})

	cleared := MicroCompact(conv, 1)
	if cleared != 1 {
		t.Errorf("cleared = %d, want 1", cleared)
	}

	// Check old message was cleared
	oldBlocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if oldBlocks[0].Content != "[cleared]" {
		t.Errorf("old tool result should be [cleared], got %v", oldBlocks[0].Content)
	}

	// Check recent message was NOT cleared
	recentBlocks := conv.Messages[2].Content.([]types.LlmContentBlock)
	if recentBlocks[0].Content == "[cleared]" {
		t.Error("recent tool result should not be cleared")
	}
}

func TestCompactWithSummary(t *testing.T) {
	conv := CreateConversation("summary-test", "", "claude-3")

	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "question"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "answer"})
	}

	summarize := func(text string) (string, error) {
		return "conversation about questions and answers", nil
	}

	err := CompactWithSummary(conv, summarize, 3)
	if err != nil {
		t.Fatal(err)
	}

	if conv.Messages[0].Role != "user" {
		t.Errorf("first message role = %q, want user", conv.Messages[0].Role)
	}
	blocks, ok := conv.Messages[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content to be []LlmContentBlock")
	}
	if !strings.Contains(blocks[0].Text, "Previous conversation summary") {
		t.Errorf("summary message missing expected text, got %q", blocks[0].Text)
	}
}

func TestSaveLoadJSONLRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("roundtrip-1", "be helpful", "claude-3")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi there"}}, types.LlmUsage{InputTokens: 10, OutputTokens: 15})
	AddUserMessage(conv, "how are you")
	UpdateCost(conv, 0.002)

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	// Verify JSONL file was created
	jsonlPath := filepath.Join(dir, "roundtrip-1.jsonl")
	if _, err := os.Stat(jsonlPath); err != nil {
		t.Fatalf("JSONL file not created: %v", err)
	}

	loaded, err := Load("roundtrip-1", dir)
	if err != nil {
		t.Fatal(err)
	}

	if loaded.ID != conv.ID {
		t.Errorf("ID = %q, want %q", loaded.ID, conv.ID)
	}
	if loaded.System != conv.System {
		t.Errorf("System = %q, want %q", loaded.System, conv.System)
	}
	if loaded.Model != conv.Model {
		t.Errorf("Model = %q, want %q", loaded.Model, conv.Model)
	}
	if loaded.TotalInputTokens != conv.TotalInputTokens {
		t.Errorf("TotalInputTokens = %d, want %d", loaded.TotalInputTokens, conv.TotalInputTokens)
	}
	if loaded.TotalOutputTokens != conv.TotalOutputTokens {
		t.Errorf("TotalOutputTokens = %d, want %d", loaded.TotalOutputTokens, conv.TotalOutputTokens)
	}
	if len(loaded.Entries) != len(conv.Entries) {
		t.Errorf("Entries count = %d, want %d", len(loaded.Entries), len(conv.Entries))
	}
	if len(loaded.Messages) != len(conv.Messages) {
		t.Errorf("Messages count = %d, want %d", len(loaded.Messages), len(conv.Messages))
	}
}

func TestSaveLoadJSONFallback(t *testing.T) {
	dir := t.TempDir()

	v1 := map[string]any{
		"id":     "legacy-1",
		"system": "sys",
		"model":  "claude-2",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
			map[string]any{"role": "assistant", "content": "world"},
		},
		"totalInputTokens":  0,
		"totalOutputTokens": 0,
		"totalCost":         0,
		"createdAt":         1700000000000,
		"version":           1,
	}

	b, _ := json.MarshalIndent(v1, "", "  ")
	jsonPath := filepath.Join(dir, "legacy-1.json")
	os.WriteFile(jsonPath, b, 0o644)

	loaded, err := Load("legacy-1", dir)
	if err != nil {
		t.Fatal(err)
	}

	if loaded.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d (should be migrated)", loaded.Version, CurrentVersion)
	}
	if len(loaded.Entries) != 2 {
		t.Errorf("expected 2 entries from migration, got %d", len(loaded.Entries))
	}
	if loaded.LeafID == nil {
		t.Error("LeafID should be set after migration")
	}
	if len(loaded.Messages) != 2 {
		t.Errorf("Messages = %d, want 2", len(loaded.Messages))
	}
}

func TestLoadNotFound(t *testing.T) {
	dir := t.TempDir()
	_, err := Load("nonexistent", dir)
	if err == nil {
		t.Error("expected error for nonexistent conversation")
	}
}

func TestMigrateConversationV0(t *testing.T) {
	raw := map[string]any{
		"id":        "v0-test",
		"system":    "",
		"model":     "claude",
		"messages":  []any{},
		"createdAt": float64(1700000000000),
	}

	conv, err := MigrateConversation(raw)
	if err != nil {
		t.Fatal(err)
	}
	if conv.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d", conv.Version, CurrentVersion)
	}
}

func TestMigrateConversationNil(t *testing.T) {
	_, err := MigrateConversation(nil)
	if err == nil {
		t.Error("expected error for nil input")
	}
}

func TestForkConversationV2(t *testing.T) {
	conv := CreateConversation("fork-v2", "", "claude-3")
	AddUserMessage(conv, "first")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "r1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "second")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "r2"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	result := ForkConversation(conv, 1)
	if result != conv {
		t.Error("v2 fork should return same conversation")
	}
	if len(conv.Messages) != 2 {
		t.Errorf("expected 2 messages after fork at index 1, got %d", len(conv.Messages))
	}
}

func TestForkConversationV1Legacy(t *testing.T) {
	conv := &Conversation{
		ID:      "fork-v1",
		System:  "sys",
		Model:   "claude-2",
		Version: 1,
		Messages: []types.LlmMessage{
			{Role: "user", Content: "hello"},
			{Role: "assistant", Content: "hi"},
			{Role: "user", Content: "bye"},
		},
	}

	forked := ForkConversation(conv, 1)
	if forked == conv {
		t.Error("v1 fork should return new conversation")
	}
	if forked.ParentID != conv.ID {
		t.Errorf("ParentID = %q, want %q", forked.ParentID, conv.ID)
	}
	if len(forked.Messages) != 2 {
		t.Errorf("expected 2 messages in fork, got %d", len(forked.Messages))
	}
}

func TestNavigateTree(t *testing.T) {
	conv := CreateConversation("nav-test", "", "claude-3")
	AddUserMessage(conv, "one")
	firstID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "two"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	msgs, err := NavigateTree(conv, firstID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Errorf("expected 1 message, got %d", len(msgs))
	}
}

func TestBuildContextPathWithCompaction(t *testing.T) {
	conv := CreateConversation("compact-ctx", "", "claude-3")

	AppendEntry(conv, EntryCompaction, CompactionData{
		Summary:          "we talked about Go",
		FirstKeptEntryID: "abc",
		TokensBefore:     5000,
	})

	AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: "continue"})

	msgs := BuildContextPath(conv)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (summary + user), got %d", len(msgs))
	}

	blocks, ok := msgs[0].Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected content blocks for compaction summary")
	}
	if !strings.Contains(blocks[0].Text, "we talked about Go") {
		t.Errorf("compaction summary not found in message: %q", blocks[0].Text)
	}
}

func TestEncodeImage(t *testing.T) {
	dir := t.TempDir()

	// Create a tiny PNG (just enough bytes to not be empty)
	pngData := []byte{
		0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
		0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
	}
	pngPath := filepath.Join(dir, "test.png")
	os.WriteFile(pngPath, pngData, 0o644)

	block, err := EncodeImage(pngPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Type != "image" {
		t.Errorf("type = %v, want image", block.Type)
	}
	if block.Source == nil {
		t.Fatal("expected source to be set")
	}
	if block.Source.MediaType != "image/png" {
		t.Errorf("media_type = %v, want image/png", block.Source.MediaType)
	}
	if block.Source.Data == "" {
		t.Error("base64 data should not be empty")
	}
}

func TestEncodeImageUnsupportedFormat(t *testing.T) {
	dir := t.TempDir()
	bmpPath := filepath.Join(dir, "test.bmp")
	os.WriteFile(bmpPath, []byte("BM"), 0o644)

	_, err := EncodeImage(bmpPath)
	if err == nil {
		t.Error("expected error for unsupported format")
	}
}

func TestEncodeImageNotFound(t *testing.T) {
	_, err := EncodeImage("/nonexistent/image.png")
	if err == nil {
		t.Error("expected error for missing file")
	}
}

// --- Deep branching ---

func TestDeepBranching(t *testing.T) {
	conv := CreateConversation("deep-branch", "", "claude-3")

	// Build a linear chain of 5 entries
	AddUserMessage(conv, "one")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "two"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "three")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "four"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "five")

	// Branch from the 3rd entry (entry index 2, "three")
	thirdID := conv.Entries[2].ID
	Branch(conv, thirdID)

	// Add alternative branch
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "alt-four"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "alt-five")

	msgs := BuildContextPath(conv)
	// Path: one, two, three, alt-four, alt-five = 5 messages
	if len(msgs) != 5 {
		t.Fatalf("expected 5 messages on alt branch, got %d", len(msgs))
	}
}

func TestMultipleBranchesFromSameParent(t *testing.T) {
	conv := CreateConversation("multi-branch", "", "claude-3")

	AddUserMessage(conv, "root")
	rootID := conv.Entries[0].ID

	// Branch 1
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "branch-1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	// Branch 2 from root
	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "branch-2"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	// Branch 3 from root
	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "branch-3"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	leaves := GetLeaves(conv)
	if len(leaves) != 3 {
		t.Fatalf("expected 3 leaves, got %d", len(leaves))
	}

	bp := GetBranchPoints(conv)
	if len(bp) != 1 {
		t.Fatalf("expected 1 branch point, got %d", len(bp))
	}
	if bp[0].ID != rootID {
		t.Fatalf("expected root as branch point, got %q", bp[0].ID)
	}
}

func TestSiblingNavigation(t *testing.T) {
	conv := CreateConversation("sibling-nav", "", "claude-3")

	AddUserMessage(conv, "root")
	rootID := conv.Entries[0].ID

	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "first-child"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	firstLeafID := *conv.LeafID

	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "second-child"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	// Navigate back to first leaf
	msgs, err := NavigateTree(conv, firstLeafID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
}

// --- Compaction: micro compact with various block types ---

func TestMicroCompact_TextOnly(t *testing.T) {
	conv := CreateConversation("micro-text", "", "claude-3")

	// Text-only messages: MicroCompact should not touch them
	for i := 0; i < 10; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	cleared := MicroCompact(conv, 3)
	if cleared != 0 {
		t.Fatalf("expected 0 cleared (no tool results), got %d", cleared)
	}
}

func TestMicroCompact_ShortToolResults(t *testing.T) {
	conv := CreateConversation("micro-short", "", "claude-3")

	// Tool results under 100 chars should not be cleared
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: "short result"},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 0 {
		t.Fatalf("expected 0 cleared (short content), got %d", cleared)
	}
}

func TestMicroCompact_MixedBlocks(t *testing.T) {
	conv := CreateConversation("micro-mixed", "", "claude-3")

	longContent := strings.Repeat("x", 200)

	// User message with both text and tool_result blocks
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "text", Text: "please read this"},
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 1 {
		t.Fatalf("expected 1 cleared, got %d", cleared)
	}

	// Text block should be preserved
	blocks := conv.Messages[0].Content.([]types.LlmContentBlock)
	if blocks[0].Text != "please read this" {
		t.Error("text block should not be cleared")
	}
	if blocks[1].Content != "[cleared]" {
		t.Error("tool_result should be cleared")
	}
}

func TestMicroCompact_MultipleToolResults(t *testing.T) {
	conv := CreateConversation("micro-multi", "", "claude-3")

	longContent := strings.Repeat("y", 200)

	// Old turn with multiple tool results
	conv.Messages = append(conv.Messages, types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{
			{Type: "tool_result", ToolUseID: "tu_1", Content: longContent},
			{Type: "tool_result", ToolUseID: "tu_2", Content: longContent},
			{Type: "tool_result", ToolUseID: "tu_3", Content: "short"},
		},
	})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "done"})

	// Recent turn
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "next"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "ok"})

	cleared := MicroCompact(conv, 1)
	if cleared != 2 {
		t.Fatalf("expected 2 cleared (two long tool results), got %d", cleared)
	}
}

// --- JSONL: large conversations ---

func TestSaveLoadJSONL_LargeConversation(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("large-conv", "sys", "claude-3")
	for i := 0; i < 100; i++ {
		AddUserMessage(conv, fmt.Sprintf("question %d", i))
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("answer %d", i)}}, types.LlmUsage{InputTokens: 10, OutputTokens: 10})
	}

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("large-conv", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(loaded.Entries) != len(conv.Entries) {
		t.Fatalf("entries: got %d, want %d", len(loaded.Entries), len(conv.Entries))
	}
	if len(loaded.Messages) != len(conv.Messages) {
		t.Fatalf("messages: got %d, want %d", len(loaded.Messages), len(conv.Messages))
	}
}

// --- JSONL: special characters ---

func TestSaveLoadJSONL_SpecialCharacters(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("special-chars", "", "claude-3")
	AddUserMessage(conv, `line1\nline2\ttab "quotes" {json}`)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "response with\nnewline"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("special-chars", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(loaded.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(loaded.Messages))
	}
}

// --- JSONL: unicode ---

func TestSaveLoadJSONL_Unicode(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("unicode-conv", "", "claude-3")
	AddUserMessage(conv, "Hello world!")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "Response with unicode chars and accents"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 5})

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("unicode-conv", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(loaded.Messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(loaded.Messages))
	}

	// Verify round-trip preserves data (content may be []interface{} after JSON decode)
	firstContent := extractText(loaded.Messages[0])
	if !utf8.ValidString(firstContent) {
		t.Error("loaded content is not valid UTF-8")
	}
	if firstContent == "" {
		t.Error("loaded content should not be empty")
	}
}

// --- Migration: v0 -> v2 ---

func TestMigrateConversation_V0ToV2_WithMessages(t *testing.T) {
	raw := map[string]any{
		"id":     "v0-msgs",
		"system": "sys",
		"model":  "claude",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
			map[string]any{"role": "assistant", "content": "hi"},
		},
		"createdAt": float64(1700000000000),
	}

	conv, err := MigrateConversation(raw)
	if err != nil {
		t.Fatal(err)
	}
	if conv.Version != CurrentVersion {
		t.Errorf("Version = %d, want %d", conv.Version, CurrentVersion)
	}
	if len(conv.Entries) != 2 {
		t.Errorf("expected 2 entries from v0 migration, got %d", len(conv.Entries))
	}
	if conv.LeafID == nil {
		t.Error("LeafID should be set after migration")
	}

	// Entries should form a chain
	if conv.Entries[0].ParentID != nil {
		t.Error("first entry should have nil parent")
	}
	if conv.Entries[1].ParentID == nil || *conv.Entries[1].ParentID != conv.Entries[0].ID {
		t.Error("second entry should point to first as parent")
	}
}

// --- Migration: v1 -> v2 ---

func TestMigrateConversation_V1ToV2(t *testing.T) {
	raw := map[string]any{
		"id":     "v1-mig",
		"system": "sys",
		"model":  "claude-2",
		"messages": []any{
			map[string]any{"role": "user", "content": "hello"},
			map[string]any{"role": "assistant", "content": "hi"},
			map[string]any{"role": "user", "content": "bye"},
		},
		"totalInputTokens":  float64(100),
		"totalOutputTokens": float64(50),
		"totalCost":         0.01,
		"createdAt":         float64(1000),
		"version":           float64(1),
	}

	conv, err := MigrateConversation(raw)
	if err != nil {
		t.Fatal(err)
	}
	if conv.Version != CurrentVersion {
		t.Errorf("Version = %d", conv.Version)
	}
	if len(conv.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(conv.Entries))
	}

	// Entries form a chain
	if conv.Entries[0].ParentID != nil {
		t.Error("first entry should have nil parent")
	}
	if *conv.Entries[1].ParentID != conv.Entries[0].ID {
		t.Error("second entry should point to first")
	}
	if *conv.Entries[2].ParentID != conv.Entries[1].ID {
		t.Error("third entry should point to second")
	}
	if *conv.LeafID != conv.Entries[2].ID {
		t.Error("leaf should point to last entry")
	}
}

func TestMigrateConversation_EmptyMessages(t *testing.T) {
	raw := map[string]any{
		"id":       "empty-mig",
		"system":   "",
		"model":    "model",
		"messages": []any{},
		"version":  float64(1),
	}

	conv, err := MigrateConversation(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(conv.Entries) != 0 {
		t.Fatalf("expected 0 entries, got %d", len(conv.Entries))
	}
	if conv.LeafID != nil {
		t.Error("LeafID should be nil for empty conversation")
	}
}

// --- Token estimation ---

func TestEstimateTokens_EmptyString(t *testing.T) {
	result := EstimateTokens("")
	if result != 0 {
		t.Fatalf("expected 0 for empty string, got %d", result)
	}
}

func TestEstimateTokens_LongString(t *testing.T) {
	text := strings.Repeat("The quick brown fox jumps over the lazy dog. ", 100)
	result := EstimateTokens(text)
	if result < 100 || result > 5000 {
		t.Fatalf("estimate = %d, expected 100-5000 range", result)
	}
}

func TestEstimateTokens_ToolUseBlocks(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "tool_use", ID: "tu_1", Name: "Read", Input: map[string]any{"file_path": "/src/main.go"}},
	}
	result := EstimateTokens(blocks)
	if result <= 0 {
		t.Fatalf("expected positive estimate for tool_use block, got %d", result)
	}
}

func TestEstimateTokens_ImageBlock(t *testing.T) {
	blocks := []types.LlmContentBlock{
		{Type: "image", Source: &types.ImageSource{Type: "base64", MediaType: "image/png", Data: strings.Repeat("A", 1000)}},
	}
	result := EstimateTokens(blocks)
	if result <= 0 {
		t.Fatalf("expected positive estimate for image block, got %d", result)
	}
}

func TestEstimateTokens_MessageArray(t *testing.T) {
	msgs := []types.LlmMessage{
		{Role: "user", Content: "hello world"},
		{Role: "assistant", Content: []types.LlmContentBlock{{Type: "text", Text: "hi there how are you"}}},
	}
	result := EstimateTokens(msgs)
	if result <= 0 {
		t.Fatalf("expected positive estimate, got %d", result)
	}
}

// --- Context usage ---

func TestGetContextUsage_PercentCap(t *testing.T) {
	conv := CreateConversation("cap-test", "", "claude-3")
	conv.TotalInputTokens = 15000
	conv.TotalOutputTokens = 15000

	info := GetContextUsage(conv, 10000)
	if info.Percent != 100 {
		t.Errorf("expected capped at 100, got %d", info.Percent)
	}
}

func TestGetContextUsage_DefaultWindow(t *testing.T) {
	conv := CreateConversation("def-win", "", "claude-3")
	AddUserMessage(conv, "hello")

	info := GetContextUsage(conv, 0)
	if info.Limit != DefaultContext {
		t.Errorf("expected %d, got %d", DefaultContext, info.Limit)
	}
}

func TestGetContextUsage_NoReportedTokens_FallsBackToEstimate(t *testing.T) {
	conv := CreateConversation("zero", "", "claude-3")

	info := GetContextUsage(conv, 200000)
	// No reported tokens, so falls back to estimation of empty messages list
	if !info.Estimated {
		t.Error("expected estimated=true when no reported tokens")
	}
	if info.Limit != 200000 {
		t.Errorf("expected limit 200000, got %d", info.Limit)
	}
}

// --- Edge cases ---

func TestBuildContextPath_EmptyConversation(t *testing.T) {
	conv := CreateConversation("empty-ctx", "", "claude-3")
	msgs := BuildContextPath(conv)
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty conversation, got %d", len(msgs))
	}
}

func TestBuildContextPath_SingleMessage(t *testing.T) {
	conv := CreateConversation("single-msg", "", "claude-3")
	AddUserMessage(conv, "only message")

	msgs := BuildContextPath(conv)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
}

func TestGetTree_EmptyConversation(t *testing.T) {
	conv := CreateConversation("empty-tree", "", "claude-3")
	tree := GetTree(conv)
	if tree != nil && len(tree) != 0 {
		t.Fatalf("expected nil or empty tree, got %d nodes", len(tree))
	}
}

func TestGetBranchPoints_LinearConversation(t *testing.T) {
	conv := CreateConversation("linear", "", "claude-3")
	AddUserMessage(conv, "one")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "two"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	bp := GetBranchPoints(conv)
	if len(bp) != 0 {
		t.Fatalf("expected 0 branch points for linear conversation, got %d", len(bp))
	}
}

func TestGetLeaves_SingleEntry(t *testing.T) {
	conv := CreateConversation("single-leaf", "", "claude-3")
	AddUserMessage(conv, "hello")

	leaves := GetLeaves(conv)
	if len(leaves) != 1 {
		t.Fatalf("expected 1 leaf, got %d", len(leaves))
	}
}

func TestCompact_AllMessages(t *testing.T) {
	conv := CreateConversation("compact-all", "", "claude-3")
	for i := 0; i < 5; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 1)
	// Should keep at least last user+assistant pair
	if len(conv.Messages) < 2 {
		t.Fatalf("expected at least 2 messages after compact(1), got %d", len(conv.Messages))
	}
}

func TestCompact_DefaultKeepTurns(t *testing.T) {
	conv := CreateConversation("compact-default", "", "claude-3")
	for i := 0; i < 20; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	Compact(conv, 0) // 0 defaults to 10
	// Should keep roughly 10 turns
	if len(conv.Messages) > 21 {
		t.Errorf("expected at most ~21 messages, got %d", len(conv.Messages))
	}
}

func TestCompactWithSummary_NoOp(t *testing.T) {
	conv := CreateConversation("no-compact", "", "claude-3")
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "hi"})
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "hello"})

	called := false
	summarize := func(text string) (string, error) {
		called = true
		return "summary", nil
	}

	err := CompactWithSummary(conv, summarize, 10)
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("summarize should not be called when messages < keepTurns")
	}
	if len(conv.Messages) != 2 {
		t.Fatalf("expected 2 messages unchanged, got %d", len(conv.Messages))
	}
}

func TestCompactWithSummary_SummarizeError_FallbackToTruncation(t *testing.T) {
	conv := CreateConversation("fail-summary", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "question"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "answer"})
	}
	before := len(conv.Messages)

	failSummarize := func(text string) (string, error) {
		return "", fmt.Errorf("LLM unavailable")
	}

	err := CompactWithSummary(conv, failSummarize, 3)
	// Error is returned but fallback truncation still happens
	if err == nil {
		t.Fatal("expected error to be returned")
	}
	if len(conv.Messages) >= before {
		t.Fatalf("expected fewer messages after fallback truncation, got %d", len(conv.Messages))
	}

	// No summary prefix in first message
	first := conv.Messages[0]
	switch c := first.Content.(type) {
	case string:
		if strings.Contains(c, "Previous conversation summary") {
			t.Error("should not contain summary after error")
		}
	case []types.LlmContentBlock:
		if len(c) > 0 && strings.Contains(c[0].Text, "Previous conversation summary") {
			t.Error("should not contain summary after error")
		}
	}
}

// --- ForkConversation v2 ---

func TestForkConversation_V2_PreservesEntries(t *testing.T) {
	conv := CreateConversation("fork-keep", "sys", "claude-3")
	for i := 0; i < 5; i++ {
		AddUserMessage(conv, fmt.Sprintf("user %d", i))
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("asst %d", i)}}, types.LlmUsage{InputTokens: 10, OutputTokens: 5})
	}

	entriesBefore := len(conv.Entries)
	ForkConversation(conv, 3)

	// All entries preserved (append-only tree)
	if len(conv.Entries) != entriesBefore {
		t.Fatalf("expected %d entries preserved, got %d", entriesBefore, len(conv.Entries))
	}
}

func TestForkConversation_V2_AtIndex0(t *testing.T) {
	conv := CreateConversation("fork-0", "sys", "claude-3")
	for i := 0; i < 3; i++ {
		AddUserMessage(conv, fmt.Sprintf("msg %d", i))
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("reply %d", i)}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	}

	ForkConversation(conv, 0)
	if len(conv.Messages) != 1 {
		t.Fatalf("expected 1 message after fork at 0, got %d", len(conv.Messages))
	}
}

func TestForkConversation_V2_PreservesSystemAndModel(t *testing.T) {
	conv := CreateConversation("fork-meta", "be helpful", "claude-opus-4-20250514")
	AddUserMessage(conv, "test")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "ok"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "more")

	ForkConversation(conv, 1)

	if conv.System != "be helpful" {
		t.Errorf("System = %q", conv.System)
	}
	if conv.Model != "claude-opus-4-20250514" {
		t.Errorf("Model = %q", conv.Model)
	}
}

func TestForkConversation_V2_NewMessagesCreateSibling(t *testing.T) {
	conv := CreateConversation("fork-sib", "", "claude-3")
	for i := 0; i < 3; i++ {
		AddUserMessage(conv, fmt.Sprintf("msg %d", i))
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("reply %d", i)}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	}

	entriesBefore := len(conv.Entries)
	ForkConversation(conv, 1) // Branch at message index 1

	// Add new message creating sibling branch
	AddUserMessage(conv, "branched message")
	if len(conv.Entries) != entriesBefore+1 {
		t.Fatalf("expected %d entries after adding branch msg, got %d", entriesBefore+1, len(conv.Entries))
	}
}

// --- DiscoverContextFiles ---

func TestDiscoverContextFiles_FindsInCwd(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("# test context"), 0o644)

	results := DiscoverContextFiles(dir, nil)
	found := false
	for _, r := range results {
		if r.Path == filepath.Join(dir, "CLAUDE.md") {
			found = true
			if r.Content != "# test context" {
				t.Errorf("unexpected content: %q", r.Content)
			}
		}
	}
	if !found {
		t.Fatal("expected to find CLAUDE.md in cwd")
	}
}

func TestDiscoverContextFiles_EmptyDir(t *testing.T) {
	dir := t.TempDir()

	results := DiscoverContextFiles(dir, []string{"NONEXISTENT.md"})
	if len(results) != 0 {
		t.Fatalf("expected 0 results, got %d", len(results))
	}
}

// --- Encode image: oversized file ---

func TestEncodeImage_OversizedFile(t *testing.T) {
	dir := t.TempDir()
	bigPath := filepath.Join(dir, "big.png")
	// Write a file just over 20MB
	buf := make([]byte, 21*1024*1024)
	os.WriteFile(bigPath, buf, 0o644)

	_, err := EncodeImage(bigPath)
	if err == nil {
		t.Fatal("expected error for oversized image")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Fatalf("expected 'too large' in error, got %q", err.Error())
	}
}

// --- JSONL: preserves metadata ---

func TestSaveLoadJSONL_PreservesMetadata(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("meta-test", "sys", "claude-3")
	conv.TotalInputTokens = 500
	conv.TotalOutputTokens = 200
	conv.TotalCost = 0.05
	AddUserMessage(conv, "test")

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("meta-test", dir)
	if err != nil {
		t.Fatal(err)
	}

	if loaded.TotalInputTokens != 500 {
		t.Errorf("TotalInputTokens = %d", loaded.TotalInputTokens)
	}
	if loaded.TotalOutputTokens != 200 {
		t.Errorf("TotalOutputTokens = %d", loaded.TotalOutputTokens)
	}
	if loaded.TotalCost < 0.049 || loaded.TotalCost > 0.051 {
		t.Errorf("TotalCost = %f", loaded.TotalCost)
	}
}

// --- JSONL: branched round-trip ---

func TestSaveLoadJSONL_BranchedConversation(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("branch-rt", "", "claude-3")
	AddUserMessage(conv, "msg1")
	firstID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp1"}}, types.LlmUsage{InputTokens: 10, OutputTokens: 5})

	Branch(conv, firstID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "alt-resp1"}}, types.LlmUsage{InputTokens: 10, OutputTokens: 5})

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("branch-rt", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(loaded.Entries) != 3 {
		t.Fatalf("expected 3 entries, got %d", len(loaded.Entries))
	}
	// Active branch: msg1 + alt-resp1
	if len(loaded.Messages) != 2 {
		t.Fatalf("expected 2 messages on active branch, got %d", len(loaded.Messages))
	}
}

// --- AppendEntry: non-message types ---

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

func TestSave_CreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "dir")

	conv := CreateConversation("dir-test", "", "claude-3")
	AddUserMessage(conv, "hello")

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("dir-test", dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ID != "dir-test" {
		t.Fatalf("expected dir-test, got %q", loaded.ID)
	}
}

// --- ForkConversation v1 legacy ---

func TestForkConversation_V1_AtBoundary(t *testing.T) {
	conv := &Conversation{
		ID:      "fork-boundary",
		System:  "sys",
		Model:   "claude-2",
		Version: 1,
		Messages: []types.LlmMessage{
			{Role: "user", Content: "only"},
		},
	}

	forked := ForkConversation(conv, 0)
	if forked == conv {
		t.Error("v1 fork should return new conversation")
	}
	if len(forked.Messages) != 1 {
		t.Fatalf("expected 1 message, got %d", len(forked.Messages))
	}
}

// --- Empty JSONL handling ---

func TestLoad_EmptyJSONLFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "empty.jsonl"), []byte(""), 0o644)

	_, err := Load("empty", dir)
	if err == nil {
		t.Fatal("expected error for empty JSONL file")
	}
}

// --- Invalid JSONL header ---

func TestLoad_InvalidJSONLHeader(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "bad.jsonl"), []byte(`{"noMeta": true}`+"\n"), 0o644)

	_, err := Load("bad", dir)
	if err == nil {
		t.Fatal("expected error for invalid JSONL header")
	}
}

// --- CompactWithSummary: receives correct text ---

func TestCompactWithSummary_ReceivesDroppedMessageText(t *testing.T) {
	conv := CreateConversation("summary-text", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: fmt.Sprintf("question-%d", i)})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: fmt.Sprintf("answer-%d", i)})
	}

	var receivedText string
	summarize := func(text string) (string, error) {
		receivedText = text
		return "mock summary", nil
	}

	CompactWithSummary(conv, summarize, 3)

	if !strings.Contains(receivedText, "[user]") {
		t.Error("expected [user] prefix in summarized text")
	}
	if !strings.Contains(receivedText, "[assistant]") {
		t.Error("expected [assistant] prefix in summarized text")
	}
}

func TestCompactWithSummary_InsertsSummaryAsFirstMessage(t *testing.T) {
	conv := CreateConversation("summary-insert", "", "claude-3")
	for i := 0; i < 15; i++ {
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: "q"})
		conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: "a"})
	}

	summarize := func(text string) (string, error) {
		return "the summary text", nil
	}

	CompactWithSummary(conv, summarize, 3)

	first := conv.Messages[0]
	if first.Role != "user" {
		t.Errorf("first message role = %q, want user", first.Role)
	}
	blocks, ok := first.Content.([]types.LlmContentBlock)
	if !ok {
		t.Fatal("expected []LlmContentBlock")
	}
	if !strings.Contains(blocks[0].Text, "Previous conversation summary") {
		t.Error("expected summary prefix")
	}
	if !strings.Contains(blocks[0].Text, "the summary text") {
		t.Error("expected summary content")
	}
}

// --- Branch and rebuild ---

func TestBranch_RebuildMessages(t *testing.T) {
	conv := CreateConversation("branch-rebuild", "", "claude-3")

	AddUserMessage(conv, "msg1")
	e1ID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	AddUserMessage(conv, "msg2")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp2"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	msgs, err := Branch(conv, e1ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message after branch to first entry, got %d", len(msgs))
	}
	if *conv.LeafID != e1ID {
		t.Error("leafID should point to branched entry")
	}
}

func TestBranch_CreatesNewSibling(t *testing.T) {
	conv := CreateConversation("branch-sibling", "", "claude-3")

	AddUserMessage(conv, "msg1")
	e1ID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})

	Branch(conv, e1ID)
	AddUserMessage(conv, "msg2-branch")

	childrenOfE1 := 0
	for _, e := range conv.Entries {
		if e.ParentID != nil && *e.ParentID == e1ID {
			childrenOfE1++
		}
	}
	if childrenOfE1 != 2 {
		t.Fatalf("expected 2 children of e1, got %d", childrenOfE1)
	}
}

// --- AddToolResults with tree ---

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

func TestLoad_V1JSON_MigratesToV2(t *testing.T) {
	dir := t.TempDir()

	v1 := map[string]any{
		"id":                "v1-compat",
		"system":            "sys",
		"model":             "claude-2",
		"messages":          []any{map[string]any{"role": "user", "content": "hello"}},
		"totalInputTokens":  float64(0),
		"totalOutputTokens": float64(0),
		"totalCost":         float64(0),
		"createdAt":         float64(1700000000000),
		"version":           float64(1),
	}

	b, _ := json.MarshalIndent(v1, "", "  ")
	os.WriteFile(filepath.Join(dir, "v1-compat.json"), b, 0o644)

	loaded, err := Load("v1-compat", dir)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Version != CurrentVersion {
		t.Errorf("expected version %d, got %d", CurrentVersion, loaded.Version)
	}
	if len(loaded.Entries) != 1 {
		t.Errorf("expected 1 entry from migration, got %d", len(loaded.Entries))
	}
}

// --- EncodeImage: supported formats ---

func TestEncodeImage_JPEG(t *testing.T) {
	dir := t.TempDir()
	jpgPath := filepath.Join(dir, "test.jpg")
	os.WriteFile(jpgPath, []byte{0xFF, 0xD8, 0xFF, 0xE0}, 0o644)

	block, err := EncodeImage(jpgPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/jpeg" {
		t.Errorf("media_type = %q, want image/jpeg", block.Source.MediaType)
	}
}

func TestEncodeImage_WebP(t *testing.T) {
	dir := t.TempDir()
	webpPath := filepath.Join(dir, "test.webp")
	os.WriteFile(webpPath, []byte("RIFF"), 0o644)

	block, err := EncodeImage(webpPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/webp" {
		t.Errorf("media_type = %q, want image/webp", block.Source.MediaType)
	}
}

func TestEncodeImage_GIF(t *testing.T) {
	dir := t.TempDir()
	gifPath := filepath.Join(dir, "test.gif")
	os.WriteFile(gifPath, []byte("GIF89a"), 0o644)

	block, err := EncodeImage(gifPath)
	if err != nil {
		t.Fatal(err)
	}
	if block.Source.MediaType != "image/gif" {
		t.Errorf("media_type = %q, want image/gif", block.Source.MediaType)
	}
}

// --- NavigateTree sets leafID and rebuilds ---

func TestNavigateTree_SetsLeafAndRebuilds(t *testing.T) {
	conv := CreateConversation("nav-rebuild", "", "claude-3")
	AddUserMessage(conv, "msg1")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp1"}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	targetID := conv.Entries[1].ID
	AddUserMessage(conv, "msg2")

	msgs, err := NavigateTree(conv, targetID)
	if err != nil {
		t.Fatal(err)
	}
	if *conv.LeafID != targetID {
		t.Error("leafID should point to target")
	}
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (msg1+resp1), got %d", len(msgs))
	}
}

// --- GetContextUsage: exact threshold ---

func TestGetContextUsage_ExactThreshold(t *testing.T) {
	conv := CreateConversation("threshold", "", "claude-3")
	conv.TotalInputTokens = 100000
	conv.TotalOutputTokens = 100000

	info := GetContextUsage(conv, 200000)
	if info.Percent != 100 {
		t.Errorf("expected 100%% at exact limit, got %d", info.Percent)
	}
}

func TestSaveLoadPreservesTreeStructure(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("tree-rt", "", "claude-3")
	AddUserMessage(conv, "root question")
	rootID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer 1"}}, types.LlmUsage{InputTokens: 5, OutputTokens: 10})

	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer 2"}}, types.LlmUsage{InputTokens: 3, OutputTokens: 7})

	if err := Save(conv, dir); err != nil {
		t.Fatal(err)
	}

	loaded, err := Load("tree-rt", dir)
	if err != nil {
		t.Fatal(err)
	}

	if len(loaded.Entries) != len(conv.Entries) {
		t.Fatalf("entries: got %d, want %d", len(loaded.Entries), len(conv.Entries))
	}

	bp := GetBranchPoints(loaded)
	if len(bp) != 1 {
		t.Errorf("expected 1 branch point after load, got %d", len(bp))
	}

	leaves := GetLeaves(loaded)
	if len(leaves) != 2 {
		t.Errorf("expected 2 leaves after load, got %d", len(leaves))
	}
}
