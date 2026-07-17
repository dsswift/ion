package conversation

import (
	"fmt"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// assertTreeInvariants verifies the properties the corruption forensics of
// conversation 1783901108497-c95abcd11560 showed can break under concurrent
// appends: every ParentID must resolve to a persisted entry, the leaf must be
// a real entry, and no append may be lost.
func assertTreeInvariants(t *testing.T, conv *Conversation, wantEntries int) {
	t.Helper()
	if len(conv.Entries) != wantEntries {
		t.Fatalf("lost appends: got %d entries, want %d", len(conv.Entries), wantEntries)
	}
	ids := make(map[string]bool, len(conv.Entries))
	for i := range conv.Entries {
		ids[conv.Entries[i].ID] = true
	}
	for i := range conv.Entries {
		p := conv.Entries[i].ParentID
		if p != nil && !ids[*p] {
			t.Fatalf("entry %s has dangling parent %s", conv.Entries[i].ID, *p)
		}
	}
	if conv.LeafID == nil {
		t.Fatal("leaf is nil after appends")
	}
	if !ids[*conv.LeafID] {
		t.Fatalf("leaf %s does not resolve to a persisted entry", *conv.LeafID)
	}
}

// TestAppendEntryConcurrent hammers AppendEntry from multiple goroutines.
// Before the tree lock existed, this lost entries to slice-reallocation races
// while LeafID kept the lost entry's id — the exact mechanism that persisted
// a child with a never-written parent and orphaned 237 of 241 messages in the
// forensic case.
func TestAppendEntryConcurrent(t *testing.T) {
	const goroutines = 8
	const perGoroutine = 50

	conv := CreateConversation("race-test", "sys", "model")

	var wg sync.WaitGroup
	for g := 0; g < goroutines; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < perGoroutine; i++ {
				AppendEntry(conv, EntryMessage, MessageData{
					Role:    "user",
					Content: []types.LlmContentBlock{{Type: "text", Text: fmt.Sprintf("g%d-%d", g, i)}},
				})
			}
		}(g)
	}
	wg.Wait()

	assertTreeInvariants(t, conv, goroutines*perGoroutine)
}

// TestAppendEntryConcurrentWithSave mirrors the production shape that
// corrupted the forensic conversation: plan/steer-marker appends run inside
// errgroup tool goroutines while Save (runloop or signal-handler flush)
// serializes the tree. Save must snapshot under the lock and never observe a
// half-applied append.
func TestAppendEntryConcurrentWithSave(t *testing.T) {
	const appends = 100

	dir := t.TempDir()
	conv := CreateConversation("race-save-test", "sys", "model")
	// Seed one real turn so Save takes the split path.
	AddUserMessage(conv, "seed")

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < appends; i++ {
			AppendEntry(conv, EntryPlanMarker, PlanMarkerData{
				Operation:    "updated",
				PlanFilePath: fmt.Sprintf("/tmp/plan-%d.md", i),
				PlanSlug:     "race",
			})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < appends/4; i++ {
			if err := Save(conv, dir); err != nil {
				t.Errorf("save: %v", err)
				return
			}
		}
	}()
	wg.Wait()

	assertTreeInvariants(t, conv, appends+1)

	// The final save must round-trip with a fully reachable chain.
	if err := Save(conv, dir); err != nil {
		t.Fatalf("final save: %v", err)
	}
	loaded, err := Load("race-save-test", dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	assertTreeInvariants(t, loaded, appends+1)
	path := getContextPathEntries(loaded)
	if len(path) != appends+1 {
		t.Fatalf("leaf walk reaches %d of %d entries", len(path), appends+1)
	}
}

// TestAppendEntryDanglingLeafRepaired pins the append-time invariant: a leaf
// pointer holding an id that is not in Entries (the residue of a lost append)
// must be repaired to the actual last entry — a dangling parent reference is
// never written.
func TestAppendEntryDanglingLeafRepaired(t *testing.T) {
	conv := CreateConversation("invariant-test", "sys", "model")
	first := AddUserMessage(conv, "hello")
	if first == nil {
		t.Fatal("expected entry")
	}

	// Simulate the lost-append residue: leaf points at an id that was never
	// persisted into Entries.
	bogus := "deadbeef"
	conv.LeafID = &bogus

	entry := AppendEntry(conv, EntryMessage, MessageData{Role: "assistant", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}})
	if entry.ParentID == nil {
		t.Fatal("expected repaired parent, got nil")
	}
	if *entry.ParentID != first.ID {
		t.Fatalf("parent repaired to %s, want last real entry %s", *entry.ParentID, first.ID)
	}
	assertTreeInvariants(t, conv, 2)
}

// TestAppendEntryDanglingLeafEmptyTree pins the empty-tree arm of the
// invariant: a bogus leaf over an empty entry list repairs to a root append.
func TestAppendEntryDanglingLeafEmptyTree(t *testing.T) {
	conv := CreateConversation("invariant-empty-test", "sys", "model")
	bogus := "deadbeef"
	conv.LeafID = &bogus

	entry := AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "hi"}}})
	if entry.ParentID != nil {
		t.Fatalf("expected nil parent on empty tree, got %s", *entry.ParentID)
	}
	assertTreeInvariants(t, conv, 1)
}

// TestLeafIDNeverAliasesEntriesSlice pins the value-copy rule: LeafID must
// not point into the Entries backing array, where a reallocation strands it.
func TestLeafIDNeverAliasesEntriesSlice(t *testing.T) {
	conv := CreateConversation("alias-test", "sys", "model")
	for i := 0; i < 64; i++ {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: []types.LlmContentBlock{{Type: "text", Text: "x"}}})
		last := &conv.Entries[len(conv.Entries)-1].ID
		if conv.LeafID == last {
			t.Fatal("LeafID aliases the Entries backing array")
		}
		if *conv.LeafID != *last {
			t.Fatalf("LeafID value %s != last entry id %s", *conv.LeafID, *last)
		}
	}
}

// TestBranchBefore pins the tree-native rewind: moving the leaf to the
// PARENT of an entry makes the next append that entry's SIBLING (replacing
// it on the active path) — not a duplicate chained after the old leaf. This
// is the primitive behind the rewind-resubmit fix: the forensic case
// persisted the same user turn twice, chained (d92ff876 after b917c1ea),
// because the resubmit appended to an unmoved leaf.
func TestBranchBefore(t *testing.T) {
	conv := CreateConversation("branch-before", "s", "m")
	first := AddUserMessage(conv, "/analyze")
	AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: "working"}}, types.LlmUsage{})
	target := AddUserMessage(conv, "follow-up")

	// Rewind to before the follow-up turn.
	if _, err := BranchBefore(conv, target.ID); err != nil {
		t.Fatalf("branch before: %v", err)
	}

	// Resubmit: the new turn must be a SIBLING of the target...
	resubmit := AddUserMessage(conv, "follow-up (edited)")
	if resubmit.ParentID == nil || *resubmit.ParentID != *target.ParentID {
		t.Fatalf("resubmit parent = %v, want target's parent %v", resubmit.ParentID, target.ParentID)
	}
	// ...and the active path must contain exactly one follow-up turn.
	path := getContextPathEntries(conv)
	followUps := 0
	for _, e := range path {
		if md := asMessageData(e.Data); md != nil && md.Role == "user" {
			followUps++
		}
	}
	if followUps != 2 { // "/analyze" + the edited resubmit; the original follow-up is off-path
		t.Fatalf("active path has %d user turns, want 2", followUps)
	}

	// Rewinding to before the ROOT clears the leaf: next turn starts fresh.
	if _, err := BranchBefore(conv, first.ID); err != nil {
		t.Fatalf("branch before root: %v", err)
	}
	if conv.LeafID != nil {
		t.Fatalf("leaf = %v, want nil after branch-before-root", *conv.LeafID)
	}
	fresh := AddUserMessage(conv, "/analyze")
	if fresh.ParentID != nil {
		t.Fatalf("fresh turn parent = %v, want nil (new root)", *fresh.ParentID)
	}

	// Unknown entry errors (never silently leaves the duplicate behavior).
	if _, err := BranchBefore(conv, "nope1234"); err == nil {
		t.Fatal("expected error for unknown entry")
	}
}
