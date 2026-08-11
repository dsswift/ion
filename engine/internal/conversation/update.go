package conversation

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Serialization for on-disk read-modify-write of a conversation.
//
// Load has no cache: every call reads the file fresh and returns an
// independent *Conversation. So a caller that Loads, appends, and Saves is
// performing a read-modify-write against the file, and two such callers
// racing on the same conversation lose one of the appends outright — the
// second writer's snapshot predates the first writer's append, and its Save
// overwrites it. This is not a torn-write problem that the atomic rename in
// writeFileSynced can solve; both writes are individually valid and the
// earlier append is simply gone.
//
// The concrete loss this was found through: a four-agent dispatch fan-out
// registers four `running` agent_dispatch records concurrently
// (session.persistDispatchRegistered). All four Load the same pre-fan-out
// file, each appends its own record, and the last Save wins — three records
// vanish. Those records are the durability half of dispatch-loss detection,
// so the fan-out case that needs them most was the case that never persisted
// them.
//
// UpdateOnDisk is the funnel that closes the window. It is process-local: it
// serializes goroutines within one engine, which is the actual concurrency
// (one daemon owns the conversation directory). It is deliberately NOT an
// advisory file lock — cross-process coordination is a different problem and
// no second writer exists today.

var (
	convLocksMu sync.Mutex
	convLocks   = map[string]*convLockEntry{}
)

// convLockEntry is a per-conversation mutex plus the count of goroutines
// currently holding or waiting on it. The count lets the map entry be dropped
// once the last user is done, so a long-lived engine that touches many
// conversations does not accumulate one mutex per conversation forever.
type convLockEntry struct {
	mu   sync.Mutex
	refs int
}

// acquireConvLock returns the mutex for convID, locked, along with the release
// function that unlocks it and drops the map entry when no one else wants it.
func acquireConvLock(convID string) func() {
	convLocksMu.Lock()
	entry, ok := convLocks[convID]
	if !ok {
		entry = &convLockEntry{}
		convLocks[convID] = entry
	}
	entry.refs++
	convLocksMu.Unlock()

	entry.mu.Lock()

	return func() {
		entry.mu.Unlock()

		convLocksMu.Lock()
		entry.refs--
		if entry.refs == 0 {
			delete(convLocks, convID)
		}
		convLocksMu.Unlock()
	}
}

// UpdateOnDisk performs a serialized read-modify-write of the conversation
// stored under convID: it Loads the conversation, hands it to mutate, and
// Saves it when mutate reports a change. Concurrent calls for the same convID
// run one at a time, so each mutate observes every earlier caller's append.
//
// mutate returns (changed, error). A false `changed` skips the Save entirely,
// which is what lets a caller no-op after inspecting the loaded state (an
// already-present record, a dedup hit) without paying a write.
//
// dir may be empty for the default conversations directory. Every failure
// branch logs with the conversation id before returning; callers treat the
// error as best-effort and continue.
func UpdateOnDisk(convID, dir string, mutate func(conv *Conversation) (bool, error)) error {
	if convID == "" {
		utils.LogWithFields(utils.LevelDebug, "conversation", "updateondisk: empty conversation id (no-op)", nil)
		return nil
	}

	release := acquireConvLock(convID)
	defer release()

	// When a run owns this conversation in memory, mutate ITS object. Loading
	// a private copy here would produce a write the owner's next save silently
	// discards — see live.go for why ownership, not merging, is the fix.
	conv := lookupLive(convID)
	live := conv != nil
	if !live {
		var err error
		conv, err = Load(convID, dir)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: load failed", map[string]any{
				"conversation_id": convID, "error": utils.ErrStr(err),
			})
			return err
		}
	}

	changed, err := mutate(conv)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: mutate failed", map[string]any{
			"conversation_id": convID, "error": utils.ErrStr(err),
		})
		return err
	}
	if !changed {
		utils.LogWithFields(utils.LevelDebug, "conversation", "updateondisk: no change (save skipped)", map[string]any{
			"conversation_id": convID, "live": live,
		})
		return nil
	}

	if err := Save(conv, dir); err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: save failed", map[string]any{
			"conversation_id": convID, "error": utils.ErrStr(err),
		})
		return err
	}

	utils.LogWithFields(utils.LevelDebug, "conversation", "updateondisk: saved", map[string]any{
		"conversation_id": convID, "live": live,
	})
	return nil
}
