package conversation

// clear_boundary_test.go — pins the agent-context-empty vs human-transcript-full
// duality that /clear creates, and the restart-reattach contract.
//
// Two tests:
//
//  1. TestClear_ContextBoundaryDuality — directly exercises clear_core.go:112-114
//     (conv.Messages = nil, token counters = 0).  In one test: after a
//     simulated /clear the loaded conversation must have Messages == nil (not
//     just len == 0 — the LLM sees no history) AND LastInputTokens == 0 AND
//     LastInputTokensMsgCount == 0, while the .tree.jsonl sidecar must still
//     contain exactly N entry lines (one per tree entry).  Both halves of the
//     duality are asserted in the same test so regression on either is caught
//     together.
//
//  2. TestClear_RestartReattach — after /clear, a fresh conversation.Load (the
//     path that loadOrCreateConversation calls on restart) must return the
//     post-clear slice (nil Messages) and NOT a slice reconstructed from the
//     tree. This pins the correctness guarantee documented in loadSplit: "NOT
//     rebuilt via BuildContextPath; whatever is in the file is the authoritative
//     LLM context."

import (
	"bufio"
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestClear_ContextBoundaryDuality directly pins clear_core.go:112-114.
//
// Scenario:
//   - Build a conversation with N user+assistant turns (Messages and Entries).
//   - Simulate /clear: set Messages = nil, zero both token counters, Save.
//   - Reload from disk and assert:
//     (a) Messages is nil — the agent context is empty.
//     (b) LastInputTokens == 0 and LastInputTokensMsgCount == 0.
//     (c) The .tree.jsonl file has exactly N non-header lines — the human
//         transcript is intact.
//
// (c) is the hard half: it proves /clear does NOT touch the tree file.
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
	if pre.LastInputTokens == 0 {
		t.Fatalf("setup: expected non-zero LastInputTokens before clear, got 0")
	}

	// Simulate clear_core.go:112-114.
	pre.Messages = nil
	pre.LastInputTokens = 0
	pre.LastInputTokensMsgCount = 0

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
	if post.LastInputTokens != 0 {
		t.Errorf("(b) LastInputTokens must be 0 after /clear; got %d", post.LastInputTokens)
	}
	if post.LastInputTokensMsgCount != 0 {
		t.Errorf("(b) LastInputTokensMsgCount must be 0 after /clear; got %d", post.LastInputTokensMsgCount)
	}

	// (c): Inspect .tree.jsonl directly to prove the tree is intact.
	// The file format is: one header line + one line per entry.
	// We count non-empty lines and subtract 1 for the header.
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
	if treeEntryLines != expectedEntries {
		t.Errorf("(c) .tree.jsonl entry lines = %d, want %d — /clear must not touch the tree (human transcript must be full)",
			treeEntryLines, expectedEntries)
	}

	// Sanity: the loaded Entries count must also match.
	if len(post.Entries) != expectedEntries {
		t.Errorf("(c) loaded Entries count = %d, want %d after /clear",
			len(post.Entries), expectedEntries)
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

	// Step 2: simulate /clear by loading, wiping Messages and counters, saving.
	// This models the clearConversationCore path.
	mid, err := Load(id, dir)
	if err != nil {
		t.Fatalf("pre-clear Load: %v", err)
	}
	mid.Messages = nil               // clear_core.go:112
	mid.LastInputTokens = 0          // clear_core.go:113
	mid.LastInputTokensMsgCount = 0  // clear_core.go:114

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
	if reattached.LastInputTokens != 0 {
		t.Errorf("restart: LastInputTokens must be 0 after /clear, got %d", reattached.LastInputTokens)
	}
	if reattached.LastInputTokensMsgCount != 0 {
		t.Errorf("restart: LastInputTokensMsgCount must be 0 after /clear, got %d", reattached.LastInputTokensMsgCount)
	}

	// The tree must still be intact — the human transcript survives.
	if len(reattached.Entries) != treeEntryCount {
		t.Errorf("restart: Entries count = %d, want %d — /clear must not destroy the tree",
			len(reattached.Entries), treeEntryCount)
	}
}
