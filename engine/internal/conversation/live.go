package conversation

import (
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Live-conversation ownership.
//
// Load has no cache, so two callers that both Load the same conversation hold
// two independent objects. When one of them keeps its copy for a long time —
// the agent run loop holds `run.conv` for the whole run and saves it at every
// turn — a second caller's disk write is not merely racy, it is doomed: the
// long-lived owner will later serialize a snapshot taken before the second
// caller existed and the write is gone. No file-level locking helps, because
// the stale state is in memory, not in the write.
//
// The concrete loss: dispatch registration writes a `running` agent_dispatch
// record mid-run (session.persistDispatchRegistered). The run loop then saves
// `run.conv`, which never saw the record, and the durability half of
// dispatch-loss detection is erased.
//
// The fix is ownership, not merging. A run registers its conversation as the
// live object for its id; while that registration stands, every other writer
// mutates THAT object instead of a disk copy. There is exactly one in-memory
// conversation per id, so the owner's next save necessarily includes the other
// writers' appends.
//
// Merging on save was the tempting alternative and it is wrong: compaction
// legitimately removes entries (TruncateEntriesAtPivot), so a save-time merge
// that re-attached entries missing from the in-memory tree would resurrect
// exactly the records a compaction had just dropped.
//
// Registration is refcounted rather than last-writer-wins so an overlapping
// re-registration (a run that starts before the previous one's release runs)
// cannot leave the map pointing at a released object.

var (
	liveMu    sync.RWMutex
	liveConvs = map[string]*liveEntry{}
)

type liveEntry struct {
	conv *Conversation
	refs int
}

// RegisterLive marks conv as the live in-memory conversation for convID and
// returns the release function that drops the registration. The caller owns
// the object for the registration's lifetime; every writer that goes through
// UpdateOnDisk will mutate this object rather than loading its own copy.
//
// Callers must defer the returned release. A registration that outlives its
// owner would route writes into an object nobody saves.
func RegisterLive(convID string, conv *Conversation) func() {
	if convID == "" || conv == nil {
		utils.LogWithFields(utils.LevelDebug, "conversation", "registerlive: skipped", map[string]any{
			"conversation_id": convID, "has_conv": conv != nil,
		})
		return func() {}
	}

	liveMu.Lock()
	entry, ok := liveConvs[convID]
	if ok && entry.conv == conv {
		entry.refs++
	} else {
		// A different object for the same id means a new owner took over
		// (the previous run's release has not landed yet). The newest owner
		// wins: it is the one whose saves are still coming.
		entry = &liveEntry{conv: conv, refs: 1}
		liveConvs[convID] = entry
	}
	refs := entry.refs
	liveMu.Unlock()

	utils.LogWithFields(utils.LevelDebug, "conversation", "registerlive: registered", map[string]any{
		"conversation_id": convID, "refs": refs,
	})

	var once sync.Once
	return func() {
		once.Do(func() {
			liveMu.Lock()
			cur, ok := liveConvs[convID]
			if ok && cur == entry {
				cur.refs--
				if cur.refs <= 0 {
					delete(liveConvs, convID)
				}
			}
			liveMu.Unlock()
			utils.LogWithFields(utils.LevelDebug, "conversation", "registerlive: released", map[string]any{
				"conversation_id": convID,
			})
		})
	}
}

// lookupLive returns the registered live conversation for convID, or nil.
func lookupLive(convID string) *Conversation {
	liveMu.RLock()
	defer liveMu.RUnlock()
	if entry, ok := liveConvs[convID]; ok {
		return entry.conv
	}
	return nil
}
