package conversation

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func addReply(conv *Conversation, text string) {
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: text}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
}

// twoBranchConv builds hello → hi → plan A → reply A, then rewinds before
// "plan A" and continues with plan B → reply B, plus a detached dispatch
// record. Returns the conversation and the two leaf ids.
func twoBranchConv(t *testing.T) (*Conversation, string, string, string) {
	t.Helper()
	conv := CreateConversation("branches-test", "", "m")
	AddUserMessage(conv, "hello")
	addReply(conv, "hi")
	fork := CurrentLeafID(conv)
	AddUserMessage(conv, "plan A")
	planA := CurrentLeafID(conv)
	addReply(conv, "reply A")
	leafA := CurrentLeafID(conv)
	if _, err := BranchBefore(conv, planA); err != nil {
		t.Fatal(err)
	}
	AddUserMessage(conv, "plan B")
	addReply(conv, "reply B")
	leafB := CurrentLeafID(conv)
	AppendDetachedEntry(conv, SessionEntry{ID: "dispatch-1", Type: EntryAgentDispatch, Data: AgentDispatchData{AgentID: "dispatch-1"}})
	return conv, fork, leafA, leafB
}

func TestListBranches_ReportsEachPathAndItsForkPoint(t *testing.T) {
	conv, fork, leafA, leafB := twoBranchConv(t)

	listing := ListBranches(conv)

	if listing.ActiveLeafID != leafB {
		t.Fatalf("active leaf = %q, want %q", listing.ActiveLeafID, leafB)
	}
	if len(listing.Branches) != 2 {
		t.Fatalf("branches = %+v, want 2 (the dispatch record is not a branch)", listing.Branches)
	}
	a, b := listing.Branches[0], listing.Branches[1]
	if a.LeafID != leafA || b.LeafID != leafB {
		t.Fatalf("leaves = %q, %q; want %q, %q", a.LeafID, b.LeafID, leafA, leafB)
	}
	if a.Active || !b.Active {
		t.Fatalf("active flags = %v, %v; want false, true", a.Active, b.Active)
	}
	if a.Preview != "reply A" || b.Preview != "reply B" {
		t.Fatalf("previews = %q, %q", a.Preview, b.Preview)
	}
	if a.MessageCount != 4 || b.MessageCount != 4 {
		t.Fatalf("message counts = %d, %d; want 4, 4", a.MessageCount, b.MessageCount)
	}
	if a.ForkPointID != fork || b.ForkPointID != fork {
		t.Fatalf("fork points = %q, %q; want %q", a.ForkPointID, b.ForkPointID, fork)
	}
	if len(listing.BranchPoints) != 1 || listing.BranchPoints[0].EntryID != fork || len(listing.BranchPoints[0].ChildIDs) != 2 {
		t.Fatalf("branch points = %+v", listing.BranchPoints)
	}
}

func TestListBranches_AfterRewindNoBranchIsActive(t *testing.T) {
	conv, fork, _, leafB := twoBranchConv(t)
	if _, err := Branch(conv, fork); err != nil {
		t.Fatal(err)
	}
	listing := ListBranches(conv)
	if listing.ActiveLeafID != fork {
		t.Fatalf("active leaf = %q, want the interior entry %q", listing.ActiveLeafID, fork)
	}
	for _, b := range listing.Branches {
		if b.Active {
			t.Fatalf("branch %q reported active while the leaf is interior (leafB %q)", b.LeafID, leafB)
		}
	}
}

func TestListBranches_RootDivergenceIsABranchPoint(t *testing.T) {
	conv := CreateConversation("root-div", "", "m")
	AddUserMessage(conv, "one")
	first := CurrentLeafID(conv)
	if _, err := BranchBefore(conv, first); err != nil {
		t.Fatal(err)
	}
	AddUserMessage(conv, "two")
	listing := ListBranches(conv)
	if len(listing.Branches) != 2 {
		t.Fatalf("branches = %+v, want 2", listing.Branches)
	}
	if len(listing.BranchPoints) != 1 || listing.BranchPoints[0].EntryID != "" {
		t.Fatalf("branch points = %+v, want the root", listing.BranchPoints)
	}
}

func TestSwitchBranch_RebuildsContextFromThatPathOnly(t *testing.T) {
	conv, fork, leafA, leafB := twoBranchConv(t)

	previous, err := SwitchBranch(conv, leafA)
	if err != nil {
		t.Fatal(err)
	}
	if previous != leafB {
		t.Fatalf("previous = %q, want %q", previous, leafB)
	}
	if CurrentLeafID(conv) != leafA {
		t.Fatalf("leaf = %q, want %q", CurrentLeafID(conv), leafA)
	}
	var texts []string
	for _, m := range conv.Messages {
		for _, b := range contentToBlocks(m.Content) {
			texts = append(texts, b.Text)
		}
	}
	want := []string{"hello", "hi", "plan A", "reply A"}
	if len(texts) != len(want) {
		t.Fatalf("context = %q, want %q", texts, want)
	}
	for i := range want {
		if texts[i] != want[i] {
			t.Fatalf("context = %q, want %q", texts, want)
		}
	}

	if _, err := SwitchBranch(conv, fork); err == nil {
		t.Fatal("switching to an interior entry must fail")
	}
	if _, err := SwitchBranch(conv, "dispatch-1"); err == nil {
		t.Fatal("switching to a detached dispatch record must fail")
	}
	if CurrentLeafID(conv) != leafA {
		t.Fatal("a rejected switch moved the leaf")
	}
}

func TestForkConversationAtLeaf_CopiesOneBranch(t *testing.T) {
	conv, _, leafA, leafB := twoBranchConv(t)

	forked, err := ForkConversationAtLeaf(conv, leafA)
	if err != nil {
		t.Fatal(err)
	}
	if len(forked.Entries) != 4 || len(forked.Messages) != 4 {
		t.Fatalf("fork has %d entries, %d messages; want 4, 4", len(forked.Entries), len(forked.Messages))
	}
	if CurrentLeafID(forked) != leafA || CurrentLeafID(conv) != leafB {
		t.Fatalf("fork leaf %q / source leaf %q", CurrentLeafID(forked), CurrentLeafID(conv))
	}
	if _, err := ForkConversationAtLeaf(conv, "missing"); err == nil {
		t.Fatal("forking an unknown leaf must fail")
	}
}
