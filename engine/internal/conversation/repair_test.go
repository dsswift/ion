package conversation

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// writeTreeFixture writes a synthetic split-format conversation to dir.
func writeTreeFixture(t *testing.T, dir, id, leafID string, entries []SessionEntry) {
	t.Helper()

	llmLines := []string{fmt.Sprintf(`{"meta":true,"id":%q,"version":2,"model":"m","system":"s","totalInputTokens":0,"totalOutputTokens":0,"totalCost":0,"createdAt":1}`, id)}
	llmLines = append(llmLines, `{"role":"user","content":[{"type":"text","text":"seed"}]}`)
	if err := os.WriteFile(filepath.Join(dir, id+".llm.jsonl"), []byte(strings.Join(llmLines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	treeLines := []string{fmt.Sprintf(`{"meta":true,"id":%q,"version":2,"leafId":%q}`, id, leafID)}
	for _, e := range entries {
		b, err := json.Marshal(e)
		if err != nil {
			t.Fatal(err)
		}
		treeLines = append(treeLines, string(b))
	}
	if err := os.WriteFile(filepath.Join(dir, id+".tree.jsonl"), []byte(strings.Join(treeLines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func msgEntry(id string, parent *string, role, text string) SessionEntry {
	return SessionEntry{
		ID:        id,
		ParentID:  parent,
		Type:      EntryMessage,
		Timestamp: 1,
		Data:      MessageData{Role: role, Content: []types.LlmContentBlock{{Type: "text", Text: text}}},
	}
}

func strPtrT(s string) *string { return &s }

// TestRepairForensicShape replicates the corruption of conversation
// 1783901108497-c95abcd11560: a long chain, then a tool_result entry whose
// parent id was never written (lost to the pre-lock append race), then a
// dangling tail the leaf points into. Before repair, walking from the leaf
// reached 4 of 241 entries; repair must make every entry reachable by
// reattaching the orphan to the entry that precedes it in file order.
func TestRepairForensicShape(t *testing.T) {
	dir := t.TempDir()
	const id = "forensic"

	// Long healthy chain e000 → e199.
	var entries []SessionEntry
	var prev *string
	for i := 0; i < 200; i++ {
		eid := fmt.Sprintf("e%03d", i)
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		entries = append(entries, msgEntry(eid, prev, role, fmt.Sprintf("turn %d", i)))
		prev = strPtrT(eid)
	}
	// The lost entry "ghost" was never persisted; its child chains to it.
	entries = append(entries, msgEntry("orphan01", strPtrT("ghost"), "user", "tool result"))
	entries = append(entries, msgEntry("tail0001", strPtrT("orphan01"), "assistant", "tail"))
	entries = append(entries, msgEntry("leaf0001", strPtrT("tail0001"), "user", "implement"))

	writeTreeFixture(t, dir, id, "leaf0001", entries)

	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	path := getContextPathEntries(conv)
	if len(path) != len(entries) {
		t.Fatalf("leaf walk reaches %d of %d entries after repair", len(path), len(entries))
	}
	if path[0].ID != "e000" {
		t.Fatalf("walk root is %s, want e000", path[0].ID)
	}
	// The orphan must be reattached to its file-order predecessor — which is
	// also the entry that produced the tool_use in the forensic case.
	for i := range conv.Entries {
		if conv.Entries[i].ID == "orphan01" {
			if conv.Entries[i].ParentID == nil || *conv.Entries[i].ParentID != "e199" {
				t.Fatalf("orphan reattached to %v, want e199", conv.Entries[i].ParentID)
			}
		}
	}

	// Save + reload must be idempotent: the repaired tree persists and a
	// second load performs zero repairs.
	if err := Save(conv, dir); err != nil {
		t.Fatalf("save: %v", err)
	}
	conv2, err := Load(id, dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	report := validateAndRepairTree(conv2)
	if report.repaired() {
		t.Fatalf("second load repaired again: %+v (repair not idempotent)", report)
	}
	if got := len(getContextPathEntries(conv2)); got != len(entries) {
		t.Fatalf("reload walk reaches %d of %d", got, len(entries))
	}
}

// TestRepairPreservesCompactionBoundary pins the partial-compaction shape: the
// FIRST file-order entry referencing a dropped parent is the designed
// truncation boundary and must become a root, not get rewired.
func TestRepairPreservesCompactionBoundary(t *testing.T) {
	dir := t.TempDir()
	const id = "compacted"

	entries := []SessionEntry{
		msgEntry("k0000001", strPtrT("dropped1"), "user", "first kept"),
		msgEntry("k0000002", strPtrT("k0000001"), "assistant", "reply"),
	}
	writeTreeFixture(t, dir, id, "k0000002", entries)

	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if conv.Entries[0].ParentID != nil {
		t.Fatalf("first entry parent = %v, want nil (compaction boundary)", *conv.Entries[0].ParentID)
	}
	path := getContextPathEntries(conv)
	if len(path) != 2 {
		t.Fatalf("walk reaches %d of 2", len(path))
	}
}

// TestRepairDanglingLeaf pins leaf repair: a header leafId that references a
// missing entry is repointed to the last file-order entry.
func TestRepairDanglingLeaf(t *testing.T) {
	dir := t.TempDir()
	const id = "dangleaf"

	entries := []SessionEntry{
		msgEntry("a0000001", nil, "user", "hi"),
		msgEntry("b0000001", strPtrT("a0000001"), "assistant", "hello"),
	}
	writeTreeFixture(t, dir, id, "missing1", entries)

	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if conv.LeafID == nil || *conv.LeafID != "b0000001" {
		t.Fatalf("leaf = %v, want b0000001", conv.LeafID)
	}
	if got := len(getContextPathEntries(conv)); got != 2 {
		t.Fatalf("walk reaches %d of 2", got)
	}
}

// TestRepairBreaksCycle pins the cycle guard: a parent loop must be severed
// so the walk terminates instead of spinning forever.
func TestRepairBreaksCycle(t *testing.T) {
	dir := t.TempDir()
	const id = "cycle"

	// a → b → c → a (cycle through parents).
	entries := []SessionEntry{
		msgEntry("a0000001", strPtrT("c0000001"), "user", "a"),
		msgEntry("b0000001", strPtrT("a0000001"), "assistant", "b"),
		msgEntry("c0000001", strPtrT("b0000001"), "user", "c"),
	}
	writeTreeFixture(t, dir, id, "c0000001", entries)

	conv, err := Load(id, dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	// Walk must terminate and reach all three entries.
	path := getContextPathEntries(conv)
	if len(path) != 3 {
		t.Fatalf("walk reaches %d of 3 after cycle break", len(path))
	}
}

// TestRepairDuplicateIDsKept pins that duplicate entry ids are counted and
// kept — the loader never drops user data.
func TestRepairDuplicateIDsKept(t *testing.T) {
	conv := &Conversation{
		ID:      "dups",
		Version: 2,
		Entries: []SessionEntry{
			msgEntry("same0001", nil, "user", "one"),
			msgEntry("same0001", strPtrT("same0001"), "user", "two"),
		},
		LeafID: strPtrT("same0001"),
	}
	report := validateAndRepairTree(conv)
	if report.DuplicateIDs != 1 {
		t.Fatalf("DuplicateIDs = %d, want 1", report.DuplicateIDs)
	}
	if len(conv.Entries) != 2 {
		t.Fatalf("entries dropped: %d", len(conv.Entries))
	}
}

// TestRepairCleanTreeNoop pins idempotence on a healthy tree.
func TestRepairCleanTreeNoop(t *testing.T) {
	conv := CreateConversation("clean", "s", "m")
	AddUserMessage(conv, "hello")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "hi"}}, types.LlmUsage{})

	report := validateAndRepairTree(conv)
	if report.repaired() || report.DuplicateIDs != 0 {
		t.Fatalf("clean tree reported repairs: %+v", report)
	}
}
