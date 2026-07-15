package conversation

// persistence_split_test.go — regression suite for the split .llm.jsonl +
// .tree.jsonl persistence format introduced to fix issue #146.
//
// Root cause of #146: loadFromJSONL called BuildContextPath to reconstruct
// Messages from Entries on every load, so zeroing Messages in /clear never
// survived a reload (the tree always had N entries → N messages rebuilt).
//
// Fix: loadSplit reads Messages verbatim from .llm.jsonl. Save writes the
// entry-derived canonical message list to .llm.jsonl, or nothing when
// Messages is nil (explicitly cleared). The tree file is untouched by /clear.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestSplit_NewFormatRoundTrip verifies that a conversation saved with the new
// format can be loaded back with identical in-memory state.
func TestSplit_NewFormatRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("split-rt", "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi there"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 15})
	AddUserMessage(conv, "how are you?")
	UpdateCost(conv, 0.002)

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	// Both sidecar files must exist.
	if _, err := os.Stat(filepath.Join(dir, "split-rt.llm.jsonl")); err != nil {
		t.Fatalf(".llm.jsonl not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "split-rt.tree.jsonl")); err != nil {
		t.Fatalf(".tree.jsonl not created: %v", err)
	}
	// Legacy file must NOT be created for new conversations.
	if _, err := os.Stat(filepath.Join(dir, "split-rt.jsonl")); err == nil {
		t.Fatal("legacy .jsonl should not be created for new-format conversation")
	}

	loaded, err := Load("split-rt", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
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
	if len(loaded.Entries) != len(conv.Entries) {
		t.Errorf("Entries count = %d, want %d", len(loaded.Entries), len(conv.Entries))
	}
	if len(loaded.Messages) != len(conv.Messages) {
		t.Errorf("Messages count = %d, want %d", len(loaded.Messages), len(conv.Messages))
	}
	if loaded.TotalInputTokens != conv.TotalInputTokens {
		t.Errorf("TotalInputTokens = %d, want %d", loaded.TotalInputTokens, conv.TotalInputTokens)
	}
	// Verify rehydration: the assistant message should have Usage set after load.
	var assistantMsg *types.LlmMessage
	for i := range loaded.Messages {
		if loaded.Messages[i].Role == "assistant" {
			assistantMsg = &loaded.Messages[i]
			break
		}
	}
	if assistantMsg != nil && assistantMsg.Usage == nil {
		t.Error("expected Usage to be rehydrated on assistant message after load")
	}
}

// TestSplit_LegacyLoadThenMigrate verifies that a legacy .jsonl file is read
// correctly, marked as legacy (_isLegacy), converted to split format on the
// next Save, and the legacy file is removed.
func TestSplit_LegacyLoadThenMigrate(t *testing.T) {
	dir := t.TempDir()
	id := "legacy-migrate"

	// Write a minimal legacy .jsonl fixture.
	header := map[string]any{
		"meta":                    true,
		"id":                      id,
		"version":                 2,
		"model":                   "claude-2",
		"system":                  "sys",
		"totalInputTokens":        100,
		"totalOutputTokens":       50,
		"lastInputTokens":         100,
		"lastInputTokensMsgCount": 2,
		"totalCost":               0.01,
		"createdAt":               float64(1700000000000),
		"leafId":                  nil,
	}
	entry1 := SessionEntry{
		ID:       "e1",
		ParentID: nil,
		Type:     EntryMessage,
		Data:     MessageData{Role: "user", Content: "hello"},
	}
	entry2 := SessionEntry{
		ID:       "e2",
		ParentID: strPtr("e1"),
		Type:     EntryMessage,
		Data:     MessageData{Role: "assistant", Content: "hi"},
	}
	header["leafId"] = "e2"

	hBytes, _ := json.Marshal(header)
	e1Bytes, _ := json.Marshal(entry1)
	e2Bytes, _ := json.Marshal(entry2)
	legacy := string(hBytes) + "\n" + string(e1Bytes) + "\n" + string(e2Bytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy fixture: %v", err)
	}

	// Load — should be flagged as legacy.
	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load legacy: %v", err)
	}
	if !conv._isLegacy {
		t.Error("expected _isLegacy=true after loading from .jsonl")
	}
	if len(conv.Entries) != 2 {
		t.Errorf("expected 2 entries from legacy, got %d", len(conv.Entries))
	}

	// Save — should write split format and remove legacy file.
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save after legacy load: %v", err)
	}

	// New files must exist.
	if _, err := os.Stat(filepath.Join(dir, id+".llm.jsonl")); err != nil {
		t.Fatalf(".llm.jsonl not created after migration: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, id+".tree.jsonl")); err != nil {
		t.Fatalf(".tree.jsonl not created after migration: %v", err)
	}
	// Legacy file must be gone.
	if _, err := os.Stat(filepath.Join(dir, id+".jsonl")); err == nil {
		t.Fatal("legacy .jsonl should be removed after migration save")
	}

	// Load again — should be clean new format, no longer legacy.
	conv2, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load after migration: %v", err)
	}
	if conv2._isLegacy {
		t.Error("expected _isLegacy=false after loading from migrated new-format files")
	}
	if len(conv2.Entries) != 2 {
		t.Errorf("expected 2 entries after migration round-trip, got %d", len(conv2.Entries))
	}
	if len(conv2.Messages) != 2 {
		t.Errorf("expected 2 messages after migration round-trip, got %d", len(conv2.Messages))
	}
}

// TestSplit_ClearMessagesPersists is the primary regression guard for #146.
//
// Scenario: save a conversation with N messages → load → zero Messages → save
// → load → assert Messages == nil AND Entries length preserved AND LeafID
// unchanged. This was the failure mode: the rebuilt-from-tree load path
// would reconstruct Messages from Entries, making the clear invisible.
func TestSplit_ClearMessagesPersists(t *testing.T) {
	dir := t.TempDir()
	id := "clear-persist"

	// Build a 10-message conversation.
	conv := CreateConversation(id, "system", "claude-3")
	for i := 0; i < 5; i++ {
		AddUserMessage(conv, "question")
		AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "answer"}},
			types.LlmUsage{InputTokens: 100, OutputTokens: 50})
	}
	savedEntryCount := len(conv.Entries)
	savedLeafID := conv.LeafID

	if err := Save(conv, dir); err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	// Load, zero Messages, save (simulating /clear).
	loaded, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load before clear: %v", err)
	}
	if len(loaded.Messages) == 0 {
		t.Fatalf("setup: expected non-zero messages before clear, got 0")
	}

	loaded.Messages = nil
	// (legacy: loaded.LastInputTokens = 0; loaded.LastInputTokensMsgCount = 0 — scalars removed)

	if err := Save(loaded, dir); err != nil {
		t.Fatalf("Save after clear: %v", err)
	}

	// Reload — Messages must still be nil (the critical assertion).
	reloaded, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load after clear: %v", err)
	}
	if len(reloaded.Messages) != 0 {
		t.Errorf("BUG #146: Messages should be nil/empty after clear, got %d messages: %+v",
			len(reloaded.Messages), reloaded.Messages)
	}
	// Entries must be preserved — the tree is NOT cleared.
	if len(reloaded.Entries) != savedEntryCount {
		t.Errorf("Entries changed after clear: got %d, want %d",
			len(reloaded.Entries), savedEntryCount)
	}
	// LeafID must be unchanged.
	if savedLeafID == nil && reloaded.LeafID != nil {
		t.Error("LeafID should remain nil after clear")
	}
	if savedLeafID != nil && (reloaded.LeafID == nil || *reloaded.LeafID != *savedLeafID) {
		t.Errorf("LeafID changed after clear: got %v, want %v", reloaded.LeafID, savedLeafID)
	}
	// After clear, GetContextUsage should fall back to the heuristic (no
	// assistant messages with Usage survive the clear).
	usage := GetContextUsage(reloaded, 200000)
	if !usage.Estimated {
		t.Errorf("expected Estimated=true after /clear (no messages to backward-scan), got Estimated=false")
	}
}

// TestSplit_OrphanLLMFileFallsBackToLegacy simulates a mid-migration crash:
// .llm.jsonl exists but .tree.jsonl does not. The load probe must NOT treat
// this as new-format (requires both files). It falls through to the legacy
// .jsonl probe. The orphan .llm.jsonl is overwritten on the next Save.
func TestSplit_OrphanLLMFileFallsBackToLegacy(t *testing.T) {
	dir := t.TempDir()
	id := "orphan-llm"

	// Write a legacy .jsonl file.
	header := map[string]any{
		"meta":    true,
		"id":      id,
		"version": 2,
		"model":   "claude-2",
		"system":  "",
		"leafId":  "e1",
	}
	entry := SessionEntry{ID: "e1", Type: EntryMessage, Data: MessageData{Role: "user", Content: "hi"}}
	hBytes, _ := json.Marshal(header)
	eBytes, _ := json.Marshal(entry)
	legacy := string(hBytes) + "\n" + string(eBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	// Write an orphan .llm.jsonl (as if a crash happened mid-migration, after
	// .llm.jsonl was renamed but before .tree.jsonl was renamed).
	orphanHeader := map[string]any{
		"meta":    true,
		"id":      id,
		"version": 2,
		"model":   "claude-2",
	}
	oBytes, _ := json.Marshal(orphanHeader)
	orphan := string(oBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".llm.jsonl"), []byte(orphan), 0o644); err != nil {
		t.Fatalf("write orphan llm: %v", err)
	}

	// Load — must use legacy (only .llm.jsonl without .tree.jsonl → not new format).
	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load with orphan .llm.jsonl: %v", err)
	}
	if !conv._isLegacy {
		t.Error("expected _isLegacy=true when .tree.jsonl is absent")
	}
	if len(conv.Entries) != 1 {
		t.Errorf("expected 1 entry from legacy .jsonl, got %d", len(conv.Entries))
	}

	// Save — orphan .llm.jsonl is overwritten, .tree.jsonl is created, legacy removed.
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save after orphan load: %v", err)
	}

	// Both new files must now exist.
	if _, err := os.Stat(filepath.Join(dir, id+".llm.jsonl")); err != nil {
		t.Fatalf(".llm.jsonl not present after migration: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, id+".tree.jsonl")); err != nil {
		t.Fatalf(".tree.jsonl not created: %v", err)
	}
	// Legacy must be gone.
	if _, err := os.Stat(filepath.Join(dir, id+".jsonl")); err == nil {
		t.Fatal("legacy .jsonl should be removed after migration save")
	}

	// Load again must succeed and not be legacy.
	conv2, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load after migration: %v", err)
	}
	if conv2._isLegacy {
		t.Error("expected _isLegacy=false after successful migration")
	}
}

// TestSplit_TreeFileMissingFallsBackToLegacy verifies that only .tree.jsonl
// existing (no .llm.jsonl) is NOT treated as new format.
func TestSplit_TreeFileMissingFallsBackToLegacy(t *testing.T) {
	dir := t.TempDir()
	id := "orphan-tree"

	// Write only a .tree.jsonl — no .llm.jsonl or .jsonl.
	treeHeader := map[string]any{
		"meta":    true,
		"id":      id,
		"version": 2,
	}
	tBytes, _ := json.Marshal(treeHeader)
	tree := string(tBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".tree.jsonl"), []byte(tree), 0o644); err != nil {
		t.Fatalf("write tree: %v", err)
	}

	// Load — must return not-found (no legacy .jsonl either).
	_, err := Load(id, dir)
	if err == nil {
		t.Fatal("expected not-found error when only .tree.jsonl exists, got nil")
	}
}

// TestSplit_LegacyUnlinkFailureIsNonFatal verifies that a failed unlink of the
// legacy .jsonl does not cause Save to return an error. Both new sidecar files
// must be written successfully regardless.
func TestSplit_LegacyUnlinkFailureIsNonFatal(t *testing.T) {
	dir := t.TempDir()
	id := "unlink-fail"

	// Create a legacy .jsonl fixture.
	header := map[string]any{
		"meta":    true,
		"id":      id,
		"version": 2,
		"model":   "claude-3",
		"leafId":  "e1",
	}
	entry := SessionEntry{ID: "e1", Type: EntryMessage, Data: MessageData{Role: "user", Content: "hi"}}
	hBytes, _ := json.Marshal(header)
	eBytes, _ := json.Marshal(entry)
	legacy := string(hBytes) + "\n" + string(eBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(legacy), 0o644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	// Load legacy.
	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !conv._isLegacy {
		t.Fatal("expected _isLegacy=true")
	}

	// Replace the legacy .jsonl with a directory so os.Remove will fail.
	if err := os.Remove(filepath.Join(dir, id+".jsonl")); err != nil {
		t.Fatalf("remove legacy for setup: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, id+".jsonl"), 0o755); err != nil {
		t.Fatalf("mkdir over legacy path: %v", err)
	}

	// Save must succeed despite the unlink failure.
	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save returned error on unlink failure: %v", err)
	}

	// Both new sidecar files must exist.
	if _, err := os.Stat(filepath.Join(dir, id+".llm.jsonl")); err != nil {
		t.Fatalf(".llm.jsonl not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, id+".tree.jsonl")); err != nil {
		t.Fatalf(".tree.jsonl not created: %v", err)
	}

	// The conversation must be loadable via the new-format probe. Since the
	// directory named "id.jsonl" is not a proper .jsonl file, and both new
	// sidecars are present, Load should use the new format.
	conv2, err := Load(id, dir)
	if err != nil {
		t.Fatalf("Load after unlink-failure save: %v", err)
	}
	if conv2._isLegacy {
		t.Error("expected _isLegacy=false — new files are the authoritative source")
	}
}

// TestSplit_BranchedRoundTrip verifies that branched conversations round-trip
// correctly through the split format — all entries are preserved, the correct
// branch is active, and branch points are intact.
func TestSplit_BranchedRoundTrip(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("branch-split", "", "claude-3")
	AddUserMessage(conv, "root")
	rootID := conv.Entries[0].ID
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "resp1"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 5})

	// Branch back to root and add an alternative response.
	Branch(conv, rootID)
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "alt-resp"}},
		types.LlmUsage{InputTokens: 10, OutputTokens: 5})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("branch-split", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if len(loaded.Entries) != 3 {
		t.Errorf("expected 3 entries, got %d", len(loaded.Entries))
	}
	// Active branch: root + alt-resp = 2 messages.
	if len(loaded.Messages) != 2 {
		t.Errorf("expected 2 messages on active branch, got %d", len(loaded.Messages))
	}
	bp := GetBranchPoints(loaded)
	if len(bp) != 1 {
		t.Errorf("expected 1 branch point, got %d", len(bp))
	}
	leaves := GetLeaves(loaded)
	if len(leaves) != 2 {
		t.Errorf("expected 2 leaves, got %d", len(leaves))
	}
}

// TestSplit_ParentIDPreserved verifies that ParentID survives the split format
// round-trip (used for chained/forked conversations).
func TestSplit_ParentIDPreserved(t *testing.T) {
	dir := t.TempDir()

	conv := CreateConversation("child-conv", "sys", "claude-3")
	conv.ParentID = "parent-conv-id"
	AddUserMessage(conv, "child question")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "child answer"}},
		types.LlmUsage{InputTokens: 5, OutputTokens: 5})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	loaded, err := Load("child-conv", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.ParentID != "parent-conv-id" {
		t.Errorf("ParentID = %q, want %q", loaded.ParentID, "parent-conv-id")
	}
}
