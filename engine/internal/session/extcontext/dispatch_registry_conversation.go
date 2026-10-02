package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Lineage-scoped conversation lookup. A dispatch's conversation is readable by
// the context that created the dispatch, directly or transitively, and by
// nobody else. The registry is the only authority for that relationship: it
// records each dispatch's parent when the dispatch starts and keeps the record
// after the dispatch ends, so the caller never supplies its own claim of
// kinship. A conversation the registry cannot tie to a dispatch the caller
// owns is refused.

// ConversationOwnership describes the dispatch whose conversation a caller is
// entitled to read.
type ConversationOwnership struct {
	DispatchID string
	Name       string
	// ConversationID is the dispatch's conversation, empty when the child
	// never started one.
	ConversationID string
	// Status is "running" or "suspended" for a live dispatch, and the
	// terminal status ("done", "error", "cancelled", "lost") for an ended one.
	Status   string
	Terminal bool
	// Reason and ExitCode are the terminal outcome. Unset while live.
	Reason   string
	ExitCode *int
}

// ResolveOwnedConversation finds the dispatch a read targets and reports it
// only when ownerID owns it. The target is named by dispatchID, by
// conversationID, or by both, in which case both must name the same dispatch.
// The ownership rule is the registry's one rule: the root context (empty
// ownerID) owns every dispatch, a dispatched agent owns its strict
// descendants.
//
// ok is false when no dispatch matches, when a matching dispatch belongs to
// another branch, and when lineage cannot be walked back to the owner. The
// three are not told apart for the caller, so a refused read never confirms
// that an unrelated conversation exists.
//
// A live dispatch is preferred over a retained one, and the newest retained
// entry over an older one, so a conversation that a later dispatch continued
// reports its current state.
func (r *DispatchRegistry) ResolveOwnedConversation(ownerID, conversationID, dispatchID string) (ConversationOwnership, bool) {
	if conversationID == "" && dispatchID == "" {
		return ConversationOwnership{}, false
	}
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()

	fields := map[string]any{"owner_dispatch_id": ownerID, "conversation_id": conversationID, "dispatch_id": dispatchID}
	if ownerID != "" {
		if _, known := r.parentOfLocked(ownerID); !known {
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "conversation read refused: owner unknown", fields)
			return ConversationOwnership{}, false
		}
	}
	if evicted := r.pruneHistoryLocked(now); evicted > 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history aged out on read", map[string]any{"evicted": evicted})
	}

	targetID := dispatchID
	if dispatchID != "" {
		if resolved, _, live := r.resolveIDLocked(dispatchID); live {
			targetID = resolved
		}
	}
	matches := func(id, convID string, aliases []string) bool {
		if dispatchID != "" && id != targetID && !containsString(aliases, dispatchID) {
			return false
		}
		return conversationID == "" || convID == conversationID
	}

	matched := false
	for _, d := range r.dispatches {
		if !matches(d.ID, d.ChildConvID, nil) {
			continue
		}
		matched = true
		if !r.descendsFromLocked(d.ID, d.ParentID, ownerID) {
			continue
		}
		status := "running"
		if d.Suspended {
			status = "suspended"
		}
		fields["resolved_dispatch_id"] = d.ID
		fields["status"] = status
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "conversation read authorized: live dispatch", fields)
		return ConversationOwnership{DispatchID: d.ID, Name: d.Name, ConversationID: d.ChildConvID, Status: status}, true
	}
	for i := len(r.history.entries) - 1; i >= 0; i-- {
		e := r.history.entries[i]
		if !matches(e.DispatchID, e.ChildConversationID, e.Aliases) {
			continue
		}
		matched = true
		if !r.descendsFromLocked(e.DispatchID, e.ParentDispatchID, ownerID) {
			continue
		}
		fields["resolved_dispatch_id"] = e.DispatchID
		fields["status"] = e.Status
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "conversation read authorized: retained dispatch", fields)
		return ConversationOwnership{
			DispatchID: e.DispatchID, Name: e.Name, ConversationID: e.ChildConversationID,
			Status: e.Status, Terminal: true, Reason: e.Reason, ExitCode: e.ExitCode,
		}, true
	}

	fields["dispatch_known"] = matched
	utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "conversation read refused: no owned dispatch for target", fields)
	return ConversationOwnership{}, false
}

func containsString(values []string, want string) bool {
	for _, v := range values {
		if v == want {
			return true
		}
	}
	return false
}
