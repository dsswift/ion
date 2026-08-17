package conversation

import (
	"errors"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Serialization for on-disk read-modify-write of a conversation.
//
// Load returns independent objects. Writers must use UpdateOnDisk or
// UpdateOrCreateOnDisk so a valid save cannot erase another mutation made from
// a stale in-memory snapshot. Both functions also route writes to the active
// run's registered conversation object when one exists.

var (
	convLocksMu sync.Mutex
	convLocks   = map[string]*convLockEntry{}
)

type convLockEntry struct {
	mu   sync.Mutex
	refs int
}

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

// UpdateOnDisk serializes one existing conversation read-modify-write.
func UpdateOnDisk(convID, dir string, mutate func(conv *Conversation) (bool, error)) error {
	return updateOnDisk(convID, dir, nil, mutate)
}

// UpdateOrCreateOnDisk serializes a mutation and creates a conversation only
// while holding its per-conversation lock. This closes the first-turn window:
// two accepted prompts cannot both observe a missing file and overwrite one
// another. create must return a conversation whose ID is convID.
func UpdateOrCreateOnDisk(convID, dir string, create func() *Conversation, mutate func(conv *Conversation) (bool, error)) error {
	return updateOnDisk(convID, dir, create, mutate)
}

func updateOnDisk(convID, dir string, create func() *Conversation, mutate func(conv *Conversation) (bool, error)) error {
	if convID == "" {
		utils.LogWithFields(utils.LevelDebug, "conversation", "updateondisk: empty conversation id (no-op)", nil)
		return nil
	}
	release := acquireConvLock(convID)
	defer release()

	conv := lookupLive(convID)
	live := conv != nil
	if !live {
		var err error
		conv, err = load(convID, dir, false)
		if err != nil {
			if create == nil || !isNotFound(err) {
				utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: load failed", map[string]any{"conversation_id": convID, "error": utils.ErrStr(err)})
				return err
			}
			conv = create()
			if conv == nil {
				return err
			}
			utils.LogWithFields(utils.LevelInfo, "conversation", "updateondisk: creating missing conversation", map[string]any{"conversation_id": convID})
		}
	}

	changed, err := mutate(conv)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: mutate failed", map[string]any{"conversation_id": convID, "error": utils.ErrStr(err)})
		return err
	}
	if !changed {
		return nil
	}
	if err := Save(conv, dir); err != nil {
		utils.LogWithFields(utils.LevelWarn, "conversation", "updateondisk: save failed", map[string]any{"conversation_id": convID, "error": utils.ErrStr(err)})
		return err
	}
	utils.LogWithFields(utils.LevelDebug, "conversation", "updateondisk: saved", map[string]any{"conversation_id": convID, "live": live})
	return nil
}

func isNotFound(err error) bool {
	return errors.Is(err, ErrNotFound)
}
