package conversation

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Locking discipline for Conversation tree state.
//
// A live *Conversation is mutated from more than one goroutine: the runloop
// appends user/assistant/tool-result entries, plan- and steer-marker appends
// run inside errgroup tool goroutines (parallel tool execution), Save runs
// from both the runloop and the signal-handler flush path, and the session
// layer reads the leaf pointer for memory boundaries. Historically none of
// this was synchronized, and a concurrent AppendEntry pair could lose an
// entry to a slice reallocation race while LeafID kept the lost entry's id —
// persisting a child whose parent was never written and silently orphaning
// everything before it on the next load.
//
// The rules:
//
//   - Every exported function that reads or writes conv.Entries, conv.LeafID,
//     or conv.Messages locks conv.mu for the duration of the access. The
//     unexported *Locked variants assume the lock is held and never lock
//     themselves (the mutex is not reentrant).
//   - Out-of-package code must never mutate conv.Entries / conv.LeafID
//     directly; it goes through AppendEntry, AppendDetachedEntry,
//     TruncateEntriesAtPivot, or the higher-level Add* helpers, and reads the
//     leaf through CurrentLeafID.
//   - Save snapshots the tree state under the lock and performs
//     marshalling/fsync outside it, so persistence never serializes a
//     half-applied append and never holds the lock across disk I/O.
//   - LeafID is always set through setLeafLocked, which stores a fresh copy
//     of the id — never a pointer into the Entries backing array. A pointer
//     into the slice survives reallocation pointing at the abandoned array,
//     which is exactly the aliasing that let a lost append leave a dangling
//     id behind.

// lock acquires the conversation's tree mutex.
func (c *Conversation) lock() { c.mu.Lock() }

// unlock releases the conversation's tree mutex.
func (c *Conversation) unlock() { c.mu.Unlock() }

// setLeafLocked points conv.LeafID at a fresh copy of id. Callers must hold
// conv.mu. Never store a pointer into the Entries slice — see the package
// locking discipline above.
func setLeafLocked(conv *Conversation, id string) {
	v := id
	conv.LeafID = &v
}

// appendEntryLocked creates a new entry chained from the current leaf and
// appends it to the tree. Callers must hold conv.mu.
//
// presetID, when non-empty, is used as the entry id instead of a freshly
// generated one — this lets the runloop pre-mint the assistant entry id so it
// can ride the message_end event before persistence happens.
//
// The parent invariant is enforced here: the entry's ParentID must reference
// an entry that exists in conv.Entries (or be nil for a root). A violation
// means the leaf pointer survived a lost append; the append is repaired to
// chain from the actual last entry and the violation is logged loudly — a
// dangling parent reference is never written.
func appendEntryLocked(conv *Conversation, entryType SessionEntryType, data any, presetID string) *SessionEntry {
	if conv.Entries == nil {
		conv.Entries = []SessionEntry{}
	}

	parentID := conv.LeafID
	if parentID != nil {
		found := false
		for i := range conv.Entries {
			if conv.Entries[i].ID == *parentID {
				found = true
				break
			}
		}
		if !found {
			repairedTo := ""
			if len(conv.Entries) > 0 {
				// Copy so the stored ParentID does not alias the slice.
				repairedTo = conv.Entries[len(conv.Entries)-1].ID
				v := repairedTo
				parentID = &v
			} else {
				parentID = nil
			}
			utils.LogWithFields(utils.LevelError, "conversation", "append: dangling parent repaired", map[string]any{
				"conversation_id": conv.ID,
				"wanted_parent":   *conv.LeafID,
				"repaired_to":     repairedTo,
				"entry_type":      string(entryType),
			})
		} else {
			// Copy so the stored ParentID does not alias conv.LeafID's storage.
			v := *parentID
			parentID = &v
		}
	}

	id := presetID
	if id == "" {
		id = GenEntryID()
	}

	entry := SessionEntry{
		ID:        id,
		ParentID:  parentID,
		Type:      entryType,
		Timestamp: nowMillis(),
		Data:      data,
	}
	conv.Entries = append(conv.Entries, entry)
	setLeafLocked(conv, id)
	return &conv.Entries[len(conv.Entries)-1]
}

// AppendDetachedEntry appends an entry verbatim — preserving its preset ID and
// ParentID — without moving the leaf pointer. This is the funnel for entries
// that are intentionally NOT part of the leaf chain, such as persisted
// agent-dispatch records (extra roots with ParentID nil). It exists so
// out-of-package callers never mutate conv.Entries directly.
func AppendDetachedEntry(conv *Conversation, entry SessionEntry) {
	conv.lock()
	defer conv.unlock()
	if conv.Entries == nil {
		conv.Entries = []SessionEntry{}
	}
	conv.Entries = append(conv.Entries, entry)
}

// TruncateEntriesAtPivot removes entries on one side of the pivot entry.
// Direction "before" keeps entries from the pivot onward (the truncated first
// entry may then reference a dropped parent — the walk treats that as a root,
// matching partial-compaction semantics). Direction "after" keeps entries up
// to and including the pivot and moves the leaf to the pivot.
//
// This is the funnel for compaction's tree truncation; it owns the LeafID
// update (by value copy, never a pointer into the slice) and the Messages
// rebuild, so out-of-package callers never mutate tree state directly.
func TruncateEntriesAtPivot(conv *Conversation, pivotEntryID, direction string) error {
	conv.lock()
	defer conv.unlock()

	if len(conv.Entries) == 0 {
		return nil
	}

	pivotIdx := -1
	for i := range conv.Entries {
		if conv.Entries[i].ID == pivotEntryID {
			pivotIdx = i
			break
		}
	}
	if pivotIdx < 0 {
		return &PivotNotFoundError{PivotID: pivotEntryID}
	}

	switch direction {
	case "before":
		conv.Entries = conv.Entries[pivotIdx:]
	case "after":
		conv.Entries = conv.Entries[:pivotIdx+1]
		setLeafLocked(conv, conv.Entries[len(conv.Entries)-1].ID)
	default:
		return &InvalidTruncateDirectionError{Direction: direction}
	}

	conv.Messages = buildContextPathLocked(conv)
	return nil
}

// PivotNotFoundError is returned by TruncateEntriesAtPivot when the pivot
// entry id does not exist in the tree.
type PivotNotFoundError struct{ PivotID string }

func (e *PivotNotFoundError) Error() string {
	return "pivot entry not found: " + e.PivotID
}

// InvalidTruncateDirectionError is returned by TruncateEntriesAtPivot for a
// direction other than "before" or "after".
type InvalidTruncateDirectionError struct{ Direction string }

func (e *InvalidTruncateDirectionError) Error() string {
	return "invalid direction: " + e.Direction + " (expected 'before' or 'after')"
}

// CurrentLeafID returns the current leaf entry id, or "" when the tree has no
// leaf. This is the read funnel for out-of-package callers (e.g. session
// memory boundaries) so they never dereference conv.LeafID while an append is
// in flight.
func CurrentLeafID(conv *Conversation) string {
	conv.lock()
	defer conv.unlock()
	if conv.LeafID == nil {
		return ""
	}
	return *conv.LeafID
}

// LeafUserText returns the concatenated text content of the current leaf
// entry when that entry is a user-role message; "" otherwise. Read funnel for
// the duplicate-turn sentinel: the runloop compares the inbound user turn
// against the current leaf to detect a double dispatch before appending.
func LeafUserText(conv *Conversation) string {
	conv.lock()
	defer conv.unlock()
	if conv.LeafID == nil {
		return ""
	}
	for i := len(conv.Entries) - 1; i >= 0; i-- {
		if conv.Entries[i].ID != *conv.LeafID {
			continue
		}
		if conv.Entries[i].Type != EntryMessage {
			return ""
		}
		md := asMessageData(conv.Entries[i].Data)
		if md == nil || md.Role != "user" {
			return ""
		}
		var parts []string
		for _, b := range contentToBlocks(md.Content) {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// PrependMessage inserts a message at the head of conv.Messages. This is the
// funnel for the compact-boundary injection (the boundary must be index 0 so
// MessagesAfterLastCompactBoundary finds it as the most recent boundary), so
// out-of-package callers never reassign conv.Messages directly.
func PrependMessage(conv *Conversation, msg types.LlmMessage) {
	conv.lock()
	defer conv.unlock()
	conv.Messages = append([]types.LlmMessage{msg}, conv.Messages...)
}

// FirstEntryID returns the id of the first tree entry, or "" when the tree is
// empty. Read funnel for out-of-package callers.
func FirstEntryID(conv *Conversation) string {
	conv.lock()
	defer conv.unlock()
	if len(conv.Entries) == 0 {
		return ""
	}
	return conv.Entries[0].ID
}
