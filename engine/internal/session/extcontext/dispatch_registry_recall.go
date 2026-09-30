package extcontext

import (
	"fmt"
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RecallOutcome is how a name-addressed Recall was resolved.
type RecallOutcome string

const (
	// RecallOutcomeRecalled: exactly one live dispatch carried the name, and it
	// (with its descendants) was recalled.
	RecallOutcomeRecalled RecallOutcome = "recalled"
	// RecallOutcomeNotFound: no live dispatch carries the name.
	RecallOutcomeNotFound RecallOutcome = "not_found"
	// RecallOutcomeAmbiguous: more than one live dispatch carries the name.
	// Nothing was recalled; the matching IDs are returned so the caller can
	// retry against one with RecallByID.
	RecallOutcomeAmbiguous RecallOutcome = "ambiguous"
)

// liveIDsByNameLocked returns the IDs of every live dispatch (reserved
// placeholders included) whose name is exactly name, sorted. Caller must hold
// r.mu.
func (r *DispatchRegistry) liveIDsByNameLocked(name string) []string {
	var ids []string
	for id, d := range r.dispatches {
		if d.Name == name {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// Recall is the name-addressed recall. It acts only when exactly one live
// dispatch carries the name. When several do, it recalls nothing and returns
// RecallOutcomeAmbiguous with every matching dispatch ID: choosing one would
// cancel a dispatch the caller may not have meant, and nothing would report
// it. The returned IDs are nil unless the outcome is ambiguous.
func (r *DispatchRegistry) Recall(name, reason string) (RecallOutcome, []string) {
	r.mu.Lock()
	matches := r.liveIDsByNameLocked(name)
	switch len(matches) {
	case 0:
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: not found", map[string]any{"agent_name": name, "reason": reason})
		return RecallOutcomeNotFound, nil
	case 1:
	default:
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: ambiguous name, nothing recalled", map[string]any{"agent_name": name, "reason": reason, "count": len(matches), "dispatch_ids": matches})
		return RecallOutcomeAmbiguous, matches
	}
	id := matches[0]
	recall := r.takeRecallLocked(id, reason)
	r.mu.Unlock()
	if recall == nil {
		return RecallOutcomeNotFound, nil
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: selected unique name match", map[string]any{"agent_name": name, "dispatch_id": id, "reason": reason})
	r.executeRecall(recall, reason)
	return RecallOutcomeRecalled, nil
}

// RecallByID cancels one active dispatch by its collision-safe dispatch ID.
// It also cancels every descendant leaves-first. This is the only destructive
// dispatch address: agent names are not identities and cannot safely select a
// concurrent dispatch instance.
func (r *DispatchRegistry) RecallByID(id, reason string) bool {
	r.mu.Lock()
	recall := r.takeRecallLocked(id, reason)
	r.mu.Unlock()
	if recall == nil {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: not found", map[string]any{"dispatch_id": id, "reason": reason})
		return false
	}
	r.executeRecall(recall, reason)
	return true
}

// takeRecallLocked atomically removes target plus descendants, retains each in
// the terminal history as cancelled with reason, and returns their live
// handles for teardown. Caller holds r.mu. A nil return means target was
// already terminal/deregistered.
//
// The target is resolved through resolveIDLocked, so a consumer-supplied
// dispatch id (registered via ClientDispatchID) addresses the same dispatch a
// steer would. Recall and steer must accept the identical id space: a harness
// that can steer a dispatch but cannot recall it — or worse, one whose recall
// silently misses and leaves the dispatch running — is the asymmetry that makes
// a timeout guard useless.
func (r *DispatchRegistry) takeRecallLocked(id, reason string) *recallSet {
	canonicalID, viaAlias, found := r.resolveIDLocked(id)
	if !found {
		return nil
	}
	if viaAlias {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: resolved consumer dispatch id through alias", map[string]any{"alias": id, "dispatch_id": canonicalID})
	}
	id = canonicalID
	target, exists := r.dispatches[id]
	if !exists {
		return nil
	}

	var descendantIDs []string
	var descendants []*activeDispatch
	queue := []string{id}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		for childID, child := range r.dispatches {
			if child.ParentID == current {
				descendantIDs = append(descendantIDs, childID)
				descendants = append(descendants, child)
				queue = append(queue, childID)
			}
		}
	}

	// Drop aliases alongside the entries they name. Recall deletes from
	// r.dispatches directly rather than going through Deregister, so without
	// this the alias would outlive its dispatch and a consumer reusing its own
	// key would have a stale alias resolve onto a recalled dispatch — a miss
	// that looks like a hit.
	delete(r.dispatches, id)
	r.dropAliasesForLocked(id)
	for _, childID := range descendantIDs {
		delete(r.dispatches, childID)
		r.dropAliasesForLocked(childID)
	}
	now := time.Now()
	cancelled := DispatchOutcome{Status: DispatchStatusCancelled, Reason: reason, ExitCode: ExitCodeRecalled}
	r.recordTerminalLocked(target, cancelled, now)
	for _, descendant := range descendants {
		r.recordTerminalLocked(descendant, cancelled, now)
	}
	return &recallSet{
		targetID: id, target: target,
		descendantIDs: descendantIDs, descendants: descendants,
		observer:  r.recallObserver,
		remaining: len(r.dispatches),
	}
}

type recallSet struct {
	targetID      string
	target        *activeDispatch
	descendantIDs []string
	descendants   []*activeDispatch
	observer      func([]RecalledDispatch)
	remaining     int
}

// executeRecall invokes durable observer then cancellation outside the registry
// lock. Cancellation is immediate: each dispatch context is cancelled during
// this call, not queued behind a steer/tool checkpoint.
func (r *DispatchRegistry) executeRecall(recall *recallSet, reason string) {
	if recall.observer != nil {
		recalled := make([]RecalledDispatch, 0, len(recall.descendants)+1)
		recalled = append(recalled, RecalledDispatch{DispatchID: recall.targetID, SessionID: recall.target.SessionID, Name: recall.target.Name})
		for index, descendant := range recall.descendants {
			recalled = append(recalled, RecalledDispatch{DispatchID: recall.descendantIDs[index], SessionID: descendant.SessionID, Name: descendant.Name})
		}
		recall.observer(recalled)
	}

	for index := len(recall.descendants) - 1; index >= 0; index-- {
		descendant := recall.descendants[index]
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cascade cancelling descendant", map[string]any{"dispatch_id": recall.descendantIDs[index], "model": descendant.Name, "reason": reason})
		if descendant.Cancel != nil {
			descendant.Cancel()
		} else {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: descendant has nil cancel func", map[string]any{"dispatch_id": recall.descendantIDs[index], "model": descendant.Name})
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cancelling", map[string]any{"dispatch_id": recall.targetID, "agent_name": recall.target.Name, "session_id": recall.target.SessionID, "reason": reason, "descendant_count": len(recall.descendants), "registry_count": recall.remaining})
	if recall.target.Cancel != nil {
		recall.target.Cancel()
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: has nil cancel func, dispatch leaked", map[string]any{"dispatch_id": recall.targetID, "model": recall.target.Name})
	}
}

// RecallOwnedByID recalls a strict descendant of ownerID. Empty ownerID is the
// root context and owns every dispatch in its session. A child does not own
// itself, ancestors, siblings, or another branch.
func (r *DispatchRegistry) RecallOwnedByID(ownerID, targetID, reason string) (bool, error) {
	r.mu.Lock()
	owned, found := r.ownsDispatchLocked(ownerID, targetID)
	if !found {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallownedbyid: target not found", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "reason": reason})
		return false, nil
	}
	if !owned {
		r.mu.Unlock()
		err := fmt.Errorf("dispatch %q is not a descendant owned by dispatch %q", targetID, ownerID)
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "recallownedbyid: ownership denied", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "reason": reason})
		return false, err
	}
	recall := r.takeRecallLocked(targetID, reason)
	r.mu.Unlock()
	if recall == nil {
		return false, nil
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallownedbyid: ownership authorized", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "reason": reason})
	r.executeRecall(recall, reason)
	return true, nil
}
