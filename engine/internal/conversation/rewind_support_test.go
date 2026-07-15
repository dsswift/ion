package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// assistant is a tiny helper to keep the tree-building in these tests readable.
func assistant(conv *Conversation, text string) {
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: text}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
}

// msgText extracts the joined text of an LlmMessage whose Content is a block
// slice (AddUserMessage / AddAssistantMessage store []LlmContentBlock).
func msgText(m types.LlmMessage) string {
	if s, ok := m.Content.(string); ok {
		return s
	}
	if blocks, ok := m.Content.([]types.LlmContentBlock); ok {
		out := ""
		for _, b := range blocks {
			out += b.Text
		}
		return out
	}
	return ""
}

func TestUserMessageEntryID_ResolvesOrdinal(t *testing.T) {
	conv := CreateConversation("rewind-ordinal", "", "claude-3")
	AddUserMessage(conv, "first")
	u1 := conv.Entries[0].ID
	assistant(conv, "resp1")
	AddUserMessage(conv, "second")
	u2 := conv.Entries[2].ID
	assistant(conv, "resp2")

	if got, ok := UserMessageEntryID(conv, 0); !ok || got != u1 {
		t.Fatalf("ordinal 0 = (%q,%v), want (%q,true)", got, ok, u1)
	}
	if got, ok := UserMessageEntryID(conv, 1); !ok || got != u2 {
		t.Fatalf("ordinal 1 = (%q,%v), want (%q,true)", got, ok, u2)
	}
	if _, ok := UserMessageEntryID(conv, 2); ok {
		t.Fatalf("ordinal 2 should be out of range")
	}
	if _, ok := UserMessageEntryID(conv, -1); ok {
		t.Fatalf("negative ordinal should be rejected")
	}
}

// The regression gate: rewinding to before a user turn and resending must leave
// exactly one copy of the new turn on the active path — never the duplicate that
// the client-side stop/start hack produced.
func TestBranchBefore_NoDuplicateOnResend(t *testing.T) {
	conv := CreateConversation("rewind-nodup", "", "claude-3")
	AddUserMessage(conv, "first")
	assistant(conv, "resp1")
	AddUserMessage(conv, "second")
	u2 := conv.Entries[2].ID
	assistant(conv, "resp2")

	entryID, ok := UserMessageEntryID(conv, 1)
	if !ok || entryID != u2 {
		t.Fatalf("resolve second turn = (%q,%v)", entryID, ok)
	}

	msgs, err := BranchBefore(conv, entryID)
	if err != nil {
		t.Fatal(err)
	}
	// Active path is now first + resp1 (second/resp2 dropped from context).
	if len(msgs) != 2 {
		t.Fatalf("after rewind, context = %d messages, want 2", len(msgs))
	}

	// Resend the (edited) turn — it must land as a sibling of the old "second",
	// not chain after it.
	AddUserMessage(conv, "second-edited")
	rebuilt := BuildContextPath(conv)
	if len(rebuilt) != 3 {
		t.Fatalf("after resend, context = %d messages, want 3 (first, resp1, second-edited)", len(rebuilt))
	}
	// The old "second" must not appear on the active path.
	for _, m := range rebuilt {
		if msgText(m) == "second" {
			t.Fatalf("rewound-past turn 'second' resurfaced on the active path")
		}
	}
	if last := msgText(rebuilt[2]); last != "second-edited" {
		t.Fatalf("last message = %q, want 'second-edited'", last)
	}
}

// Rewinding to before the first user turn (the operator's exact scenario) must
// empty the context and resend from a fresh root — one copy, no duplicate.
func TestBranchBefore_FirstMessage(t *testing.T) {
	conv := CreateConversation("rewind-first", "", "claude-3")
	AddUserMessage(conv, "only")
	u1 := conv.Entries[0].ID
	assistant(conv, "resp")

	msgs, err := BranchBefore(conv, u1)
	if err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 0 {
		t.Fatalf("rewind before first turn = %d messages, want 0", len(msgs))
	}

	AddUserMessage(conv, "only-again")
	rebuilt := BuildContextPath(conv)
	if len(rebuilt) != 1 {
		t.Fatalf("after resend from root = %d messages, want 1", len(rebuilt))
	}
	if s := msgText(rebuilt[0]); s != "only-again" {
		t.Fatalf("root message = %q, want 'only-again'", s)
	}
}

func TestPlanStateAtLeaf(t *testing.T) {
	conv := CreateConversation("rewind-plan", "", "claude-3")
	AddUserMessage(conv, "first")
	AppendEntry(conv, EntryPlanMarker, PlanMarkerData{Operation: "created", PlanFilePath: "/plans/x.md", PlanSlug: "x"})
	AddUserMessage(conv, "second")
	AppendEntry(conv, EntryPlanMarker, PlanMarkerData{Operation: "updated", PlanFilePath: "/plans/y.md", PlanSlug: "y"})
	AddUserMessage(conv, "third")

	// At the live leaf, the last marker (y) is in effect.
	if path, slug := PlanStateAtLeaf(conv); path != "/plans/y.md" || slug != "y" {
		t.Fatalf("at leaf = (%q,%q), want (/plans/y.md, y)", path, slug)
	}

	// Rewind to before the second user turn → leaf lands on marker x's path,
	// so the plan in effect is x.
	e2, _ := UserMessageEntryID(conv, 1)
	if _, err := BranchBefore(conv, e2); err != nil {
		t.Fatal(err)
	}
	if path, slug := PlanStateAtLeaf(conv); path != "/plans/x.md" || slug != "x" {
		t.Fatalf("after rewind before turn 1 = (%q,%q), want (/plans/x.md, x)", path, slug)
	}

	// Rewind to before the first user turn → no plan precedes the leaf.
	e1, _ := UserMessageEntryID(conv, 0)
	if _, err := BranchBefore(conv, e1); err != nil {
		t.Fatal(err)
	}
	if path, slug := PlanStateAtLeaf(conv); path != "" || slug != "" {
		t.Fatalf("after rewind before turn 0 = (%q,%q), want empty", path, slug)
	}
}
