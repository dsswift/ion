package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// OwnsDispatch reports whether ownerID has authority to recall targetID.
// Root authority is encoded as an empty owner ID. A dispatched agent owns only
// strict descendants: never itself, ancestors, siblings, or another branch.
func (r *DispatchRegistry) OwnsDispatch(ownerID, targetID string) (owned, found bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ownsDispatchLocked(ownerID, targetID)
}

func (r *DispatchRegistry) ownsDispatchLocked(ownerID, targetID string) (owned, found bool) {
	target, found := r.dispatches[targetID]
	if !found {
		return false, false
	}
	if ownerID == "" {
		return true, true
	}
	if ownerID == targetID {
		return false, true
	}
	if _, ownerExists := r.dispatches[ownerID]; !ownerExists {
		return false, false
	}

	visited := map[string]bool{targetID: true}
	parentID := target.ParentID
	for parentID != "" {
		if parentID == ownerID {
			return true, true
		}
		if visited[parentID] {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "ownsdispatch: ancestry cycle", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "cycle_id": parentID})
			return false, true
		}
		visited[parentID] = true
		parent, exists := r.dispatches[parentID]
		if !exists {
			// Parent may have completed/deregistered. It cannot prove live
			// ownership, so fail closed rather than let an orphan cross branches.
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "ownsdispatch: parent missing", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "parent_dispatch_id": parentID})
			return false, true
		}
		parentID = parent.ParentID
	}
	return false, true
}

// OwnedSnapshot returns live dispatches the caller owns. Root sees all; a
// dispatched agent sees only strict descendants. This is discovery authority,
// not merely display filtering: callers receive no sibling/ancestor IDs to use
// in a destructive request.
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
		status := "running"
		var pending []string
		if dispatch.Suspended {
			status = "suspended"
			for childID := range dispatch.PendingChildren {
				pending = append(pending, childID)
			}
		}
		var lastActivityMs int64
		if !dispatch.LastActivityAt.IsZero() {
			lastActivityMs = now.Sub(dispatch.LastActivityAt).Milliseconds()
		}
		entries = append(entries, DispatchStateEntry{
			DispatchID: id, Name: dispatch.Name, Status: status,
			ParentDispatchID: dispatch.ParentID, Depth: dispatch.Depth,
			StartedAt: dispatch.StartedAt, ElapsedMs: now.Sub(dispatch.StartedAt).Milliseconds(),
			ToolCount: dispatch.ToolCount, LastWork: dispatch.LastWork,
			LastActivityMs: lastActivityMs, ChildConversationID: dispatch.ChildConvID,
			PendingChildren: pending,
		})
	}
	return entries
}
