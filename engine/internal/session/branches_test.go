package session

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// seedBranchedConv persists hello → hi → A → reply A, rewound before A and
// continued with B → reply B. Returns the two leaf ids.
func seedBranchedConv(t *testing.T, convID string) (string, string) {
	t.Helper()
	conv := conversation.CreateConversation(convID, "system", "test-model")
	reply := func(text string) {
		conversation.AddAssistantMessage(conv, []types.LlmContentBlock{{Type: "text", Text: text}}, types.LlmUsage{InputTokens: 1, OutputTokens: 1})
	}
	conversation.AddUserMessage(conv, "hello")
	reply("hi")
	conversation.AddUserMessage(conv, "A")
	turnA := conversation.CurrentLeafID(conv)
	reply("reply A")
	leafA := conversation.CurrentLeafID(conv)
	if _, err := conversation.BranchBefore(conv, turnA); err != nil {
		t.Fatal(err)
	}
	conversation.AddUserMessage(conv, "B")
	reply("reply B")
	leafB := conversation.CurrentLeafID(conv)
	if err := conversation.Save(conv, ""); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	return leafA, leafB
}

func startBranchSession(t *testing.T, key, convID string) *Manager {
	t.Helper()
	mgr := NewManager(newMockBackend())
	if _, err := mgr.StartSession(key, defaultConfig()); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(key) })
	mgr.mu.Lock()
	mgr.sessions[key].conversationID = convID
	mgr.mu.Unlock()
	return mgr
}

func TestSwitchSessionBranch_PersistsTheNewPathAndAnnouncesIt(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	const key, convID = "branch-switch", "branch-switch-conv"
	leafA, leafB := seedBranchedConv(t, convID)
	mgr := startBranchSession(t, key, convID)

	var mu sync.Mutex
	var changed []*types.ActivePathChangedEvent
	mgr.OnEvent(func(emittedKey string, ev types.EngineEvent) {
		if emittedKey == key && ev.Type == "engine_active_path_changed" {
			mu.Lock()
			changed = append(changed, ev.ActivePathChanged)
			mu.Unlock()
		}
	})

	listing, err := mgr.ListSessionBranches(key)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Branches) != 2 || listing.ActiveLeafID != leafB {
		t.Fatalf("listing = %+v", listing)
	}

	if err := mgr.SwitchSessionBranch(key, leafA); err != nil {
		t.Fatalf("SwitchSessionBranch: %v", err)
	}

	loaded, err := conversation.Load(convID, filepath.Join(home, ".ion", "conversations"))
	if err != nil {
		t.Fatal(err)
	}
	if conversation.CurrentLeafID(loaded) != leafA || len(loaded.Messages) != 4 {
		t.Fatalf("persisted leaf %q with %d messages; want %q with 4", conversation.CurrentLeafID(loaded), len(loaded.Messages), leafA)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(changed) != 1 {
		t.Fatalf("engine_active_path_changed emitted %d times, want 1", len(changed))
	}
	if got := *changed[0]; got.ConversationID != convID || got.LeafID != leafA || got.PreviousLeafID != leafB {
		t.Fatalf("event = %+v", got)
	}
}

func TestSwitchSessionBranch_RefusedWhileARunIsActiveOrForANonLeaf(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const key, convID = "branch-busy", "branch-busy-conv"
	leafA, leafB := seedBranchedConv(t, convID)
	mgr := startBranchSession(t, key, convID)

	mgr.mu.Lock()
	mgr.sessions[key].requestID = "run-1"
	mgr.mu.Unlock()
	if err := mgr.SwitchSessionBranch(key, leafA); err == nil {
		t.Fatal("switch during an active run must be refused")
	}
	mgr.mu.Lock()
	mgr.sessions[key].requestID = ""
	mgr.mu.Unlock()

	if err := mgr.SwitchSessionBranch(key, "not-an-entry"); err == nil {
		t.Fatal("switch to an unknown entry must fail")
	}
	listing, err := mgr.ListSessionBranches(key)
	if err != nil {
		t.Fatal(err)
	}
	if listing.ActiveLeafID != leafB {
		t.Fatalf("a refused switch moved the leaf to %q", listing.ActiveLeafID)
	}
}

func TestForkSessionAtLeaf_OpensTheOtherBranchBesideThisOne(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	const key, convID = "branch-fork", "branch-fork-conv"
	leafA, leafB := seedBranchedConv(t, convID)
	mgr := startBranchSession(t, key, convID)

	newKey, forkedID, err := mgr.ForkSessionAtLeaf(key, "branch-fork-copy", leafA)
	if err != nil {
		t.Fatalf("ForkSessionAtLeaf: %v", err)
	}
	t.Cleanup(func() { _ = mgr.StopSession(newKey) })
	forked, err := conversation.Load(forkedID, "")
	if err != nil {
		t.Fatal(err)
	}
	if conversation.CurrentLeafID(forked) != leafA || len(forked.Messages) != 4 {
		t.Fatalf("fork leaf %q with %d messages", conversation.CurrentLeafID(forked), len(forked.Messages))
	}
	listing, err := mgr.ListSessionBranches(key)
	if err != nil {
		t.Fatal(err)
	}
	if listing.ActiveLeafID != leafB {
		t.Fatalf("forking moved the source leaf to %q", listing.ActiveLeafID)
	}
}
