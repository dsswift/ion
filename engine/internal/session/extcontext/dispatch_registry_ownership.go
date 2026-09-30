package extcontext

import (
	"time"
)

// OwnsDispatch reports whether ownerID has authority to recall targetID.
// Root authority is encoded as an empty owner ID. A dispatched agent owns only
// strict descendants: never itself, ancestors, siblings, or another branch.
func (r *DispatchRegistry) OwnsDispatch(ownerID, targetID string) (owned, found bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ownsDispatchLocked(ownerID, targetID)
}

// ownsDispatchLocked reports whether ownerID has authority over the live
// dispatch targetID. found is false when targetID is not live, or when the
// owner is neither live nor retained (an unknown caller proves nothing).
// Lineage walks through finished ancestors (descendsFromLocked), so a parent
// keeps authority over a grandchild whose own parent has already finished.
func (r *DispatchRegistry) ownsDispatchLocked(ownerID, targetID string) (owned, found bool) {
	target, found := r.dispatches[targetID]
	if !found {
		return false, false
	}
	if ownerID == "" {
		return true, true
	}
	if _, known := r.parentOfLocked(ownerID); !known {
		return false, false
	}
	return r.descendsFromLocked(targetID, target.ParentID, ownerID), true
}

// OwnedSnapshot returns live dispatches the caller owns. Root sees all; a
// dispatched agent sees only strict descendants. This is discovery authority,
// not merely display filtering: callers receive no sibling/ancestor IDs to use
// in a destructive request.
//
// Entries are built by the same snapshotEntryLocked helper Snapshot uses, so
// this ancestry-filtered view carries every field the root view does (tool
// count, last activity, WaitingOn, etc.) without a second field list to keep
// in sync by hand.
func (r *DispatchRegistry) OwnedSnapshot(ownerID string) []DispatchStateEntry {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	entries := make([]DispatchStateEntry, 0, len(r.dispatches))
	for id, dispatch := range r.dispatches {
		owned, found := r.ownsDispatchLocked(ownerID, id)
		if !found || !owned {
			continue
		}
		entries = append(entries, snapshotEntryLocked(dispatch, now))
	}
	return entries
}
