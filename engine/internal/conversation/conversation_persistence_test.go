package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
)

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

func TestSaveLoadJSONL_PreservesMetadata(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("meta-test", "sys", "claude-3")
	conv.TotalInputTokens = 500
	conv.TotalOutputTokens = 200
	conv.LastInputTokens = 300
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
	if loaded.LastInputTokens != 300 {
		t.Errorf("LastInputTokens = %d", loaded.LastInputTokens)
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
