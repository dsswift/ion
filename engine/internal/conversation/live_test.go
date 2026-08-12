package conversation

// live_test.go — in-memory ownership of a conversation.
//
// The defect: a run loop loads a conversation once and holds it for the whole
// run, saving it at every turn. A second writer that loaded its own copy from
// disk mid-run has its append erased by the run's next save — not a torn
// write, a valid save of state that predates the append. Dispatch registration
// records were lost this way, which is the durability half of dispatch-loss
// detection.

import (
	"testing"
)

// seedConversation writes a one-message conversation and returns its id.
func seedConversation(t *testing.T, dir, id string) {
	t.Helper()
	conv := CreateConversation(id, "system", "test-model")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed Save: %v", err)
	}
}

func dispatchEntry(id string) SessionEntry {
	return SessionEntry{
		ID:        id,
		ParentID:  nil,
		Type:      EntryAgentDispatch,
		Timestamp: nowMillis(),
		Data:      AgentDispatchData{AgentID: id, AgentName: id, Status: "running"},
	}
}

// TestLiveOwnership_RunSaveDoesNotEraseConcurrentAppend is the regression
// test. Without RegisterLive the final assertion reads zero dispatch records:
// the run's save serializes a tree that never saw the append.
func TestLiveOwnership_RunSaveDoesNotEraseConcurrentAppend(t *testing.T) {
	dir := t.TempDir()
	seedConversation(t, dir, "live-clobber")

	// A run loads the conversation and holds it, as runLoop does.
	runConv, err := Load("live-clobber", dir)
	if err != nil {
		t.Fatalf("run load: %v", err)
	}
	release := RegisterLive("live-clobber", runConv)
	defer release()

	// Mid-run, another writer appends a dispatch record.
	if err := UpdateOnDisk("live-clobber", dir, func(c *Conversation) (bool, error) {
		AppendDetachedEntry(c, dispatchEntry("dispatch-1"))
		return true, nil
	}); err != nil {
		t.Fatalf("UpdateOnDisk: %v", err)
	}

	// The run continues and saves its own object at the next turn.
	AddUserMessage(runConv, "next turn")
	if err := Save(runConv, dir); err != nil {
		t.Fatalf("run save: %v", err)
	}

	loaded, err := Load("live-clobber", dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	records := AgentDispatchEntries(loaded)
	if len(records) != 1 {
		t.Fatalf("dispatch records after the run's save = %d, want 1 (the run erased a concurrent append)", len(records))
	}
	if records[0].AgentID != "dispatch-1" {
		t.Errorf("record AgentID = %q, want dispatch-1", records[0].AgentID)
	}
}

// TestLiveOwnership_WriteLandsOnTheLiveObject pins the mechanism rather than
// just its outcome: the append must be visible in the owner's in-memory tree
// immediately, without the owner reloading.
func TestLiveOwnership_WriteLandsOnTheLiveObject(t *testing.T) {
	dir := t.TempDir()
	seedConversation(t, dir, "live-visible")

	runConv, err := Load("live-visible", dir)
	if err != nil {
		t.Fatalf("run load: %v", err)
	}
	release := RegisterLive("live-visible", runConv)
	defer release()

	if err := UpdateOnDisk("live-visible", dir, func(c *Conversation) (bool, error) {
		if c != runConv {
			t.Error("mutate received a disk copy, not the registered live object")
		}
		AppendDetachedEntry(c, dispatchEntry("dispatch-live"))
		return true, nil
	}); err != nil {
		t.Fatalf("UpdateOnDisk: %v", err)
	}

	if n := len(AgentDispatchEntries(runConv)); n != 1 {
		t.Fatalf("records visible on the live object = %d, want 1", n)
	}
}

// TestLiveOwnership_FallsBackToDiskAfterRelease verifies the registration is
// scoped: once the run ends, writers load from disk again.
func TestLiveOwnership_FallsBackToDiskAfterRelease(t *testing.T) {
	dir := t.TempDir()
	seedConversation(t, dir, "live-released")

	runConv, err := Load("live-released", dir)
	if err != nil {
		t.Fatalf("run load: %v", err)
	}
	release := RegisterLive("live-released", runConv)
	release()

	if err := UpdateOnDisk("live-released", dir, func(c *Conversation) (bool, error) {
		if c == runConv {
			t.Error("mutate received the released object; ownership outlived the run")
		}
		AppendDetachedEntry(c, dispatchEntry("dispatch-after"))
		return true, nil
	}); err != nil {
		t.Fatalf("UpdateOnDisk: %v", err)
	}

	loaded, err := Load("live-released", dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if n := len(AgentDispatchEntries(loaded)); n != 1 {
		t.Fatalf("records on disk = %d, want 1", n)
	}
}

// TestLiveOwnership_ReleaseIsIdempotent guards the release path: removeRun may
// run after a defer already fired in some paths, and a double release must not
// drop a newer owner's registration.
func TestLiveOwnership_ReleaseIsIdempotent(t *testing.T) {
	dir := t.TempDir()
	seedConversation(t, dir, "live-idem")

	first, err := Load("live-idem", dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	release := RegisterLive("live-idem", first)
	release()
	release() // second call must be a no-op

	second, err := Load("live-idem", dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	releaseSecond := RegisterLive("live-idem", second)
	defer releaseSecond()

	if got := lookupLive("live-idem"); got != second {
		t.Fatal("a repeated release dropped the newer owner's registration")
	}
}

// TestLiveOwnership_CompactionTruncationIsNotResurrected is why ownership was
// chosen over merging at save time. Compaction legitimately removes entries; a
// save-time merge that re-attached entries missing from the in-memory tree
// would put them back.
func TestLiveOwnership_CompactionTruncationIsNotResurrected(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("live-compact", "system", "test-model")
	AddUserMessage(conv, "first")
	AppendDetachedEntry(conv, dispatchEntry("dispatch-old"))
	AddUserMessage(conv, "second")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// The owner truncates away the earlier entries, dispatch record included.
	runConv, err := Load("live-compact", dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	release := RegisterLive("live-compact", runConv)
	defer release()

	pivot := runConv.Entries[len(runConv.Entries)-1].ID
	if err := TruncateEntriesAtPivot(runConv, pivot, "before"); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := Save(runConv, dir); err != nil {
		t.Fatalf("save after truncate: %v", err)
	}

	loaded, err := Load("live-compact", dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if n := len(AgentDispatchEntries(loaded)); n != 0 {
		t.Fatalf("dispatch records after truncation = %d, want 0 (a dropped entry must not come back)", n)
	}
}
