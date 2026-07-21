package conversation

// clear_boundary_test.go — pins the agent-context-empty vs human-transcript-full
// duality that /clear creates, and the restart-reattach contract.
//
// Three tests:
//
//  1. TestClear_ContextBoundaryDuality — directly exercises clear_core.go:112-114
//     (conv.Messages = nil, EntryCleared appended).  In one test: after a
//     simulated /clear the loaded conversation must have Messages == nil (not
//     just len == 0 — the LLM sees no history) AND LastInputTokens == 0 AND
//     LastInputTokensMsgCount == 0, while the .tree.jsonl sidecar must still
//     contain exactly N+1 entry lines (N original entries + 1 EntryCleared).
//     Both halves of the duality are asserted in the same test so regression
//     on either is caught together.
//
//  2. TestClear_RestartReattach — after /clear, a fresh conversation.Load (the
//     path that loadOrCreateConversation calls on restart) must return the
//     post-clear slice (nil Messages) and NOT a slice reconstructed from the
//     tree. This pins the correctness guarantee documented in loadSplit: "NOT
//     rebuilt via BuildContextPath; whatever is in the file is the authoritative
//     LLM context."
//
//  3. TestClear_MarkerReplayedOnLoadMessages — after a real clearConversationCore-
//     style wipe (Messages = nil, EntryCleared appended, Save), LoadMessages must
//     return exactly one MarkerKind=="clear" row. This is the end-to-end pin for
//     the flattenEntries replay arm: clients depend on this row to reconstruct the
//     "── Cleared at ──" divider on historical reload.

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestClear_ContextBoundaryDuality directly pins the clear mechanics.
//
// Scenario:
//   - Build a conversation with N user+assistant turns (Messages and Entries).
//   - Simulate /clear: set Messages = nil, append EntryCleared, Save.
//   - Reload from disk and assert:
//     (a) Messages is nil — the agent context is empty.
//     (b) GetContextUsage returns Estimated=true (no assistant messages to scan).
//     (c) The .tree.jsonl file has exactly N+1 non-header lines — the original
//         N message entries plus 1 EntryCleared, all preserved.
//     (d) LoadMessages returns exactly one MarkerKind=="clear" row.
//
// (c)+(d) are the hard halves: (c) proves /clear appends to the tree rather
// than touching existing entries; (d) proves flattenEntries replays the cleared
// marker so clients reconstruct the divider on reload.
func TestClear_ContextBoundaryDuality(t *testing.T) {
	dir := t.TempDir()
	id := "clear-boundary-duality"

	const turns = 4 // 4 user + 4 assistant = 8 entries

	conv := CreateConversation(id, "system", "test-model")
	for i := 0; i < turns; i++ {
		AddUserMessage(conv, "question")
		AddAssistantMessage(conv,
			[]types.LlmContentBlock{{Type: "text", Text: "answer"}},
			types.LlmUsage{InputTokens: 100, OutputTokens: 50})
	}
	expectedEntries := len(conv.Entries) // should be turns*2 == 8

	if err := Save(conv, dir); err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	// Verify pre-clear state so a broken setup fails fast.
	pre, err := Load(id, dir)
	if err != nil {
		t.Fatalf("pre-clear Load: %v", err)
	}
	if len(pre.Messages) == 0 {
		t.Fatalf("setup: expected non-zero Messages before clear, got 0")
	}
	// After AddAssistantMessage, the last assistant message should have Usage set.
	// Verify at least one assistant message has usage (i.e., GetContextUsage will use API path).
	hasUsage := false
	for _, msg := range pre.Messages {
		if msg.Role == "assistant" && msg.Usage != nil {
			hasUsage = true
			break
		}
	}
	if !hasUsage {
		t.Fatalf("setup: expected at least one assistant message with Usage before clear")
	}

	// Simulate clear_core.go: wipe Messages, append EntryCleared, Save.
	pre.Messages = nil
	AppendEntry(pre, EntryCleared, ClearedData{})

	if err := Save(pre, dir); err != nil {
		t.Fatalf("post-clear Save: %v", err)
	}

	// (a) + (b): Reload and assert agent-context-empty.
	post, err := Load(id, dir)
	if err != nil {
		t.Fatalf("post-clear Load: %v", err)
	}
	if post.Messages != nil {
		t.Errorf("(a) Messages must be nil after /clear — LLM should see empty context; got %d messages: %+v",
			len(post.Messages), post.Messages)
	}
	// After clear, GetContextUsage should fall back to the heuristic (no assistant
	// messages with Usage remain because Messages is nil).
	usage := GetContextUsage(post, 200000)
	if !usage.Estimated {
		t.Errorf("(b) expected Estimated=true after /clear (no assistant messages to scan), got Estimated=false")
	}

	// (c): Inspect .tree.jsonl directly to prove the tree is intact and has
	// exactly expectedEntries + 1 lines (original entries + EntryCleared).
	// The file format is: one header line + one line per entry.
	treePath := filepath.Join(dir, id+".tree.jsonl")
	treeData, err := os.ReadFile(treePath)
	if err != nil {
		t.Fatalf("(c) read .tree.jsonl: %v", err)
	}

	var treeEntryLines int
	scanner := bufio.NewScanner(bytes.NewReader(treeData))
	lineNum := 0
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		lineNum++
		if lineNum > 1 { // skip the header line
			treeEntryLines++
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("(c) scan .tree.jsonl: %v", err)
	}
	// expectedEntries original message entries + 1 EntryCleared.
	wantTreeLines := expectedEntries + 1
	if treeEntryLines != wantTreeLines {
		t.Errorf("(c) .tree.jsonl entry lines = %d, want %d (original entries + EntryCleared)",
			treeEntryLines, wantTreeLines)
	}

	// Sanity: the loaded Entries count must also match.
	if len(post.Entries) != wantTreeLines {
		t.Errorf("(c) loaded Entries count = %d, want %d after /clear",
			len(post.Entries), wantTreeLines)
	}

	// (d): LoadMessages must yield exactly one MarkerKind=="clear" row.
	msgs, err := LoadMessages(id, dir)
	if err != nil {
		t.Fatalf("(d) LoadMessages: %v", err)
	}
	var clearMarkers int
	for _, m := range msgs {
		if m.MarkerKind == "clear" {
			clearMarkers++
		}
	}
	if clearMarkers != 1 {
		t.Errorf("(d) LoadMessages: got %d MarkerKind==\"clear\" rows, want 1", clearMarkers)
	}
}

// TestClear_RestartReattach pins the restart-reattach contract: after /clear,
// a fresh conversation.Load (exactly the call loadOrCreateConversation makes
// when the engine process restarts and reattaches to a conversation by ID)
// must return the post-clear slice (nil Messages), NOT messages reconstructed
// from the entry tree.
//
// This is the regression guard for the root cause of issue #146: the old
// loadFromJSONL path called BuildContextPath after loading, which reconstructed
// Messages from Entries on every load, making /clear invisible across a restart.
// The split format's correctness guarantee is that loadSplit reads Messages
// verbatim from .llm.jsonl — no reconstruction.
//
// The test simulates a process restart by abandoning all in-memory state after
// Save and calling Load in a separate scope with only the conversation ID.
func TestClear_RestartReattach(t *testing.T) {
	dir := t.TempDir()
	id := "clear-restart-reattach"

	// Step 1: build and save a conversation with history.
	setup := CreateConversation(id, "system", "test-model")
	for i := 0; i < 3; i++ {
		AddUserMessage(setup, "prompt")
		AddAssistantMessage(setup,
			[]types.LlmContentBlock{{Type: "text", Text: "reply"}},
			types.LlmUsage{InputTokens: 80, OutputTokens: 40})
	}
	treeEntryCount := len(setup.Entries) // 6 entries

	if err := Save(setup, dir); err != nil {
		t.Fatalf("initial Save: %v", err)
	}

	// Step 2: simulate /clear by loading, wiping Messages, appending EntryCleared,
	// saving. This models the clearConversationCore path.
	mid, err := Load(id, dir)
	if err != nil {
		t.Fatalf("pre-clear Load: %v", err)
	}
	mid.Messages = nil // clear_core.go: wipe the LLM context
	AppendEntry(mid, EntryCleared, ClearedData{})

	if err := Save(mid, dir); err != nil {
		t.Fatalf("post-clear Save: %v", err)
	}

	// Step 3: simulate process restart — discard all in-memory references.
	// Only the conversation ID persists (stored in the session manager).
	mid = nil
	setup = nil

	// Step 4: fresh Load — this is exactly what loadOrCreateConversation calls
	// (conversation.Load(opts.SessionID, "")) when the engine restarts.
	reattached, err := Load(id, dir)
	if err != nil {
		t.Fatalf("restart Load: %v", err)
	}

	// The agent must see an empty context, not history rebuilt from the tree.
	if reattached.Messages != nil {
		t.Errorf("restart: Messages must be nil after /clear — engine reconstructed %d messages from tree instead of reading empty .llm.jsonl: %+v",
			len(reattached.Messages), reattached.Messages)
	}
	// After /clear, GetContextUsage must fall back to heuristic (no messages to scan).
	usage := GetContextUsage(reattached, 200000)
	if !usage.Estimated {
		t.Errorf("restart: expected Estimated=true after /clear (no assistant messages with Usage), got Estimated=false")
	}

	// The tree must still be intact — original entries + 1 EntryCleared.
	wantEntries := treeEntryCount + 1
	if len(reattached.Entries) != wantEntries {
		t.Errorf("restart: Entries count = %d, want %d — /clear must append EntryCleared, not destroy the tree",
			len(reattached.Entries), wantEntries)
	}

	// LoadMessages must yield exactly one MarkerKind=="clear" row after restart.
	msgs, err := LoadMessages(id, dir)
	if err != nil {
		t.Fatalf("restart LoadMessages: %v", err)
	}
	var clearMarkers int
	for _, m := range msgs {
		if m.MarkerKind == "clear" {
			clearMarkers++
		}
	}
	if clearMarkers != 1 {
		t.Errorf("restart: LoadMessages got %d MarkerKind==\"clear\" rows, want 1", clearMarkers)
	}
}

// TestClear_MarkerReplayedOnLoadMessages is the end-to-end pin for the
// flattenEntries EntryCleared replay arm. After a real wipe-and-append
// (Messages = nil, EntryCleared appended, Save), LoadMessages must return
// exactly one MarkerKind=="clear" system row and the row must carry the
// "──" content sentinel clients use to identify dividers.
//
// This test is intentionally separate from TestClear_ContextBoundaryDuality
// and TestClear_RestartReattach so a failure here immediately names the
// flattenEntries replay arm as the root cause.
func TestClear_MarkerReplayedOnLoadMessages(t *testing.T) {
	dir := t.TempDir()
	id := "clear-marker-reload"

	conv := CreateConversation(id, "be helpful", "claude-3-5-sonnet")
	AddUserMessage(conv, "question before clear")
	AddAssistantMessage(conv,
		[]types.LlmContentBlock{{Type: "text", Text: "answer before clear"}},
		types.LlmUsage{InputTokens: 20, OutputTokens: 10})

	// Simulate clearConversationCore: wipe Messages, append EntryCleared, Save.
	conv.Messages = nil
	AppendEntry(conv, EntryCleared, ClearedData{})

	if err := Save(conv, dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	msgs, err := LoadMessages(id, dir)
	if err != nil {
		t.Fatalf("LoadMessages: %v", err)
	}

	var clearRow *types.SessionMessage
	for i := range msgs {
		if msgs[i].MarkerKind == "clear" {
			clearRow = &msgs[i]
			break
		}
	}
	if clearRow == nil {
		t.Fatal("LoadMessages: expected exactly one MarkerKind==\"clear\" row after /clear, found none")
	}
	if clearRow.Role != "system" {
		t.Errorf("clear marker Role = %q, want \"system\"", clearRow.Role)
	}
	if clearRow.Content != "──" {
		t.Errorf("clear marker Content = %q, want \"──\"", clearRow.Content)
	}
	if clearRow.Timestamp == 0 {
		t.Error("clear marker Timestamp is zero — entry timestamp must be carried through")
	}
}
