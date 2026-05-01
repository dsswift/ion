package conversation

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

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
