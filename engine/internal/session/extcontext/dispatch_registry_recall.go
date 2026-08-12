package extcontext

import "github.com/dsswift/ion/engine/internal/utils"

// Recall cancels an active background dispatch by name and removes it
// from the registry. When multiple dispatches share the same name, this
// cancels the FIRST one found (non-deterministic). For targeted recall,
// use RecallByID. Cascades: all descendant dispatches (children,
// grandchildren, etc.) are also cancelled and deregistered. Returns true
// if the named dispatch was found and cancelled.
func (r *DispatchRegistry) Recall(name string, reason string) bool {
	r.mu.Lock()
	var found *activeDispatch
	var foundID string
	for id, d := range r.dispatches {
		if d.Name == name {
			found = d
			foundID = id
			break
		}
	}
	if found == nil {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: not found", map[string]any{"model": name, "reason": reason})
		return false
	}

	// Collect descendants before deleting anything.
	var descIDs []string
	var descDispatches []*activeDispatch
	queue := []string{foundID}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for id, d := range r.dispatches {
			if d.ParentID == cur {
				descIDs = append(descIDs, id)
				descDispatches = append(descDispatches, d)
				queue = append(queue, id)
			}
		}
	}

	delete(r.dispatches, foundID)
	for _, id := range descIDs {
		delete(r.dispatches, id)
	}
	observer := r.recallObserver
	r.mu.Unlock()

	if observer != nil {
		recalled := make([]RecalledDispatch, 0, len(descDispatches)+1)
		recalled = append(recalled, RecalledDispatch{DispatchID: foundID, SessionID: found.SessionID, Name: found.Name})
		for i, descendant := range descDispatches {
			recalled = append(recalled, RecalledDispatch{DispatchID: descIDs[i], SessionID: descendant.SessionID, Name: descendant.Name})
		}
		observer(recalled)
	}

	// Cancel descendants first (leaves before parent) for orderly teardown.
	for i := len(descDispatches) - 1; i >= 0; i-- {
		dd := descDispatches[i]
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: cascade cancelling descendant", map[string]any{"desc_i_ds_i": descIDs[i], "model": dd.Name, "reason": reason})
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: cancelling", map[string]any{"dispatch_id": foundID, "agent_name": name, "session_id": found.SessionID, "reason": reason, "descendant_count": len(descDispatches), "registry_count": r.Count()})

	if found.Cancel != nil {
		found.Cancel()
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recall: has nil cancel func, dispatch leaked", map[string]any{"found_i_d": foundID, "model": name})
	}

	return true
}

// RecallByID cancels a specific dispatch by its unique ID and removes it
// from the registry. Cascades: all descendant dispatches are also
// cancelled. Returns true if the dispatch was found and cancelled.
func (r *DispatchRegistry) RecallByID(id string, reason string) bool {
	r.mu.Lock()
	d, exists := r.dispatches[id]
	if !exists {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: not found", map[string]any{"run_id": id, "reason": reason})
		return false
	}

	// Collect descendants before deleting anything.
	var descIDs []string
	var descDispatches []*activeDispatch
	queue := []string{id}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for did, dd := range r.dispatches {
			if dd.ParentID == cur {
				descIDs = append(descIDs, did)
				descDispatches = append(descDispatches, dd)
				queue = append(queue, did)
			}
		}
	}

	delete(r.dispatches, id)
	for _, did := range descIDs {
		delete(r.dispatches, did)
	}
	observer := r.recallObserver
	r.mu.Unlock()

	if observer != nil {
		recalled := make([]RecalledDispatch, 0, len(descDispatches)+1)
		recalled = append(recalled, RecalledDispatch{DispatchID: id, SessionID: d.SessionID, Name: d.Name})
		for i, descendant := range descDispatches {
			recalled = append(recalled, RecalledDispatch{DispatchID: descIDs[i], SessionID: descendant.SessionID, Name: descendant.Name})
		}
		observer(recalled)
	}

	// Cancel descendants first (leaves before parent).
	for i := len(descDispatches) - 1; i >= 0; i-- {
		dd := descDispatches[i]
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cascade cancelling descendant", map[string]any{"desc_i_ds_i": descIDs[i], "model": dd.Name, "reason": reason})
		if dd.Cancel != nil {
			dd.Cancel()
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cancelling", map[string]any{"dispatch_id": id, "agent_name": d.Name, "session_id": d.SessionID, "reason": reason, "descendant_count": len(descDispatches), "registry_count": r.Count()})

	if d.Cancel != nil {
		d.Cancel()
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: has nil cancel func, dispatch leaked", map[string]any{"run_id": id, "model": d.Name})
	}

	return true
}
