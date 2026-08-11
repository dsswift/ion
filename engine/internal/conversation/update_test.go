package conversation

// update_test.go — concurrency tests for conversation persistence:
// the shared-temp-file rename race in writeFileSynced and the lost-update
// race in the Load/mutate/Save read-modify-write.

import (
	"fmt"
	"sync"
	"testing"
)

// TestSaveConcurrent_NoTempFileRace saves the same conversation from many
// goroutines at once. With a shared `path + ".tmp"` temp name, the first
// rename consumes the temp file and every other writer fails with
// "rename ...tmp: no such file or directory"; with a per-call temp name every
// save is independently atomic and all of them succeed.
func TestSaveConcurrent_NoTempFileRace(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("save-concurrent", "system", "test-model")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	const writers = 16
	errs := make(chan error, writers)
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- Save(conv, dir)
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent Save failed: %v", err)
		}
	}

	// The file must still be loadable: a lost temp file also means a
	// truncated or missing target.
	if _, err := Load("save-concurrent", dir); err != nil {
		t.Fatalf("Load after concurrent saves: %v", err)
	}
}

// TestUpdateOnDisk_ConcurrentAppendsAllSurvive is the dispatch fan-out case.
// Each goroutine appends one distinct detached entry through UpdateOnDisk.
// Unserialized (plain Load/append/Save) all writers snapshot the same
// pre-fan-out file and the last save wins, so only one entry survives;
// serialized, every append observes the previous ones and all survive.
func TestUpdateOnDisk_ConcurrentAppendsAllSurvive(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("update-concurrent", "system", "test-model")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	const appenders = 8
	var wg sync.WaitGroup
	errs := make(chan error, appenders)
	for i := 0; i < appenders; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			id := fmt.Sprintf("dispatch-%d", n)
			errs <- UpdateOnDisk("update-concurrent", dir, func(c *Conversation) (bool, error) {
				AppendDetachedEntry(c, SessionEntry{
					ID:        id,
					ParentID:  nil,
					Type:      EntryAgentDispatch,
					Timestamp: nowMillis(),
					Data: AgentDispatchData{
						AgentName: id,
						AgentID:   id,
						Status:    "running",
					},
				})
				return true, nil
			})
		}(i)
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatalf("UpdateOnDisk failed: %v", err)
		}
	}

	loaded, err := Load("update-concurrent", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	got := map[string]bool{}
	for _, d := range AgentDispatchEntries(loaded) {
		got[d.AgentID] = true
	}
	if len(got) != appenders {
		t.Fatalf("dispatch records persisted = %d, want %d (records lost to concurrent read-modify-write)", len(got), appenders)
	}
	for i := 0; i < appenders; i++ {
		if id := fmt.Sprintf("dispatch-%d", i); !got[id] {
			t.Errorf("dispatch record %q missing", id)
		}
	}
}

// TestUpdateOnDisk_NoChangeSkipsSave verifies the false-changed arm: a mutate
// that reports no change must not rewrite the file. This is the no-op path
// persistDispatchRegistered takes when a record is already present.
func TestUpdateOnDisk_NoChangeSkipsSave(t *testing.T) {
	dir := t.TempDir()
	conv := CreateConversation("update-noop", "system", "test-model")
	AddUserMessage(conv, "hello")
	if err := Save(conv, dir); err != nil {
		t.Fatalf("seed Save: %v", err)
	}

	err := UpdateOnDisk("update-noop", dir, func(c *Conversation) (bool, error) {
		AppendDetachedEntry(c, SessionEntry{
			ID:        "should-not-persist",
			Type:      EntryAgentDispatch,
			Timestamp: nowMillis(),
			Data:      AgentDispatchData{AgentID: "should-not-persist", Status: "running"},
		})
		return false, nil
	})
	if err != nil {
		t.Fatalf("UpdateOnDisk: %v", err)
	}

	loaded, err := Load("update-noop", dir)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if n := len(AgentDispatchEntries(loaded)); n != 0 {
		t.Fatalf("dispatch entries persisted = %d, want 0 (changed=false must skip Save)", n)
	}
}

// TestUpdateOnDisk_LoadFailurePropagates pins the error arm: a missing
// conversation surfaces the load error rather than silently succeeding.
func TestUpdateOnDisk_LoadFailurePropagates(t *testing.T) {
	dir := t.TempDir()
	called := false
	err := UpdateOnDisk("does-not-exist", dir, func(c *Conversation) (bool, error) {
		called = true
		return true, nil
	})
	if err == nil {
		t.Fatal("expected error for missing conversation, got nil")
	}
	if called {
		t.Error("mutate must not run when Load fails")
	}
}
