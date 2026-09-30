package extcontext

import (
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// RecallOutcome is how an owner-scoped recall was resolved.
type RecallOutcome string

const (
	// RecallOutcomeRecalled: the target (with its descendants) was recalled.
	RecallOutcomeRecalled RecallOutcome = "recalled"
	// RecallOutcomeNotFound: no dispatch with that identity is known.
	RecallOutcomeNotFound RecallOutcome = "not_found"
	// RecallOutcomeAmbiguous: a name matched more than one live dispatch the
	// caller owns. Nothing was recalled; the matching IDs are returned so the
	// caller can retry against one by ID.
	RecallOutcomeAmbiguous RecallOutcome = "ambiguous"
	// RecallOutcomeUnauthorized: the dispatch exists but the caller does not
	// own it.
	RecallOutcomeUnauthorized RecallOutcome = "unauthorized"
	// RecallOutcomeCompleted: the caller owns the dispatch but it had already
	// finished. The terminal entry is returned.
	RecallOutcomeCompleted RecallOutcome = "completed"
)

// RecallControlResult is the full result of an owner-scoped recall.
// MatchingIDs is set only for RecallOutcomeAmbiguous; Terminal only for
// RecallOutcomeCompleted.
type RecallControlResult struct {
	Outcome     RecallOutcome
	MatchingIDs []string
	Terminal    *DispatchTerminalEntry
}

// ownedLiveIDsByNameLocked returns the IDs of every live dispatch (reserved
// placeholders included) ownerID owns whose name is exactly name, sorted.
// Name lookup searches the same scope ID lookup accepts. Caller must hold r.mu.
func (r *DispatchRegistry) ownedLiveIDsByNameLocked(ownerID, name string) []string {
	var ids []string
	for id, d := range r.dispatches {
		if d.Name == name && r.descendsFromLocked(id, d.ParentID, ownerID) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// RecallOwnedByName recalls the one live dispatch ownerID owns that carries
// name. When several do, it recalls nothing and returns
// RecallOutcomeAmbiguous with every matching dispatch ID: choosing one would
// cancel a dispatch the caller may not have meant, and nothing would report
// it. A name outside the caller's scope is not found.
func (r *DispatchRegistry) RecallOwnedByName(ownerID, name, reason string) RecallControlResult {
	r.mu.Lock()
	matches := r.ownedLiveIDsByNameLocked(ownerID, name)
	r.mu.Unlock()
	switch len(matches) {
	case 0:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: not found", map[string]any{"agent_name": name, "owner_dispatch_id": ownerID, "reason": reason})
		return RecallControlResult{Outcome: RecallOutcomeNotFound}
	case 1:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: selected unique name match", map[string]any{"agent_name": name, "owner_dispatch_id": ownerID, "dispatch_id": matches[0], "reason": reason})
		return r.RecallOwnedByID(ownerID, matches[0], reason)
	default:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recall: ambiguous name, nothing recalled", map[string]any{"agent_name": name, "owner_dispatch_id": ownerID, "reason": reason, "count": len(matches), "dispatch_ids": matches})
		return RecallControlResult{Outcome: RecallOutcomeAmbiguous, MatchingIDs: matches}
	}
}

// RecallByID cancels one active dispatch by its collision-safe dispatch ID
// with root authority, cascading to every descendant leaves-first. It is the
// engine's internal recall verb; extension-facing recalls go through
// RecallOwnedByID.
func (r *DispatchRegistry) RecallByID(id, reason string) bool {
	return r.RecallOwnedByID("", id, reason).Outcome == RecallOutcomeRecalled
}

// RecallOwnedByID recalls the dispatch identified by targetID (canonical ID
// or consumer alias) on behalf of ownerID, cascading to its descendants. The
// root context (empty ownerID) owns every dispatch in the registry; a
// dispatched agent owns only its strict descendants, never itself, an
// ancestor, a sibling, or another branch.
func (r *DispatchRegistry) RecallOwnedByID(ownerID, targetID, reason string) RecallControlResult {
	r.mu.Lock()
	canonical, _, live := r.resolveIDLocked(targetID)
	if live {
		target := r.dispatches[canonical]
		if !r.descendsFromLocked(canonical, target.ParentID, ownerID) {
			r.mu.Unlock()
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "recallownedbyid: ownership denied", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "reason": reason})
			return RecallControlResult{Outcome: RecallOutcomeUnauthorized}
		}
		recall := r.takeRecallLocked(canonical, reason)
		r.mu.Unlock()
		if recall != nil {
			utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallownedbyid: ownership authorized", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "reason": reason})
			r.executeRecall(recall, reason)
			return RecallControlResult{Outcome: RecallOutcomeRecalled}
		}
	} else {
		r.mu.Unlock()
	}
	kind, terminal := r.resolveMiss(ownerID, targetID, "recall", string(RecallOutcomeUnauthorized))
	switch kind {
	case missCompleted:
		return RecallControlResult{Outcome: RecallOutcomeCompleted, Terminal: terminal}
	case missUnauthorized:
		return RecallControlResult{Outcome: RecallOutcomeUnauthorized}
	default:
		return RecallControlResult{Outcome: RecallOutcomeNotFound}
	}
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

	// Record each terminal entry, then leave the live set. Leaving also drops
	// the live aliases, so a consumer reusing its own key never has a stale
	// alias resolve onto a recalled dispatch; recording first keeps those
	// aliases on the terminal entry.
	now := time.Now()
	cancelled := DispatchOutcome{Status: DispatchStatusCancelled, Reason: reason, ExitCode: ExitCodeRecalled}
	terminals := []DispatchTerminalEntry{r.recordTerminalLocked(target, cancelled, now)}
	for _, descendant := range descendants {
		terminals = append(terminals, r.recordTerminalLocked(descendant, cancelled, now))
	}
	r.leaveLocked(id)
	for _, childID := range descendantIDs {
		r.leaveLocked(childID)
	}
	return &recallSet{
		targetID: id, target: target,
		descendantIDs: descendantIDs, descendants: descendants,
		observer:         r.recallObserver,
		terminals:        terminals,
		terminalObserver: r.terminalObserver,
		remaining:        len(r.dispatches),
	}
}

type recallSet struct {
	targetID         string
	target           *activeDispatch
	descendantIDs    []string
	descendants      []*activeDispatch
	observer         func([]RecalledDispatch)
	terminals        []DispatchTerminalEntry
	terminalObserver func([]DispatchTerminalEntry)
	remaining        int
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
	if recall.terminalObserver != nil {
		recall.terminalObserver(recall.terminals)
	}

	for index := len(recall.descendants) - 1; index >= 0; index-- {
		descendant := recall.descendants[index]
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cascade cancelling descendant", map[string]any{"dispatch_id": recall.descendantIDs[index], "model": descendant.Name, "reason": reason})
		if descendant.Cancel != nil {
			descendant.Cancel(reason)
		} else {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: descendant has nil cancel func", map[string]any{"dispatch_id": recall.descendantIDs[index], "model": descendant.Name})
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recallbyid: cancelling", map[string]any{"dispatch_id": recall.targetID, "agent_name": recall.target.Name, "session_id": recall.target.SessionID, "reason": reason, "descendant_count": len(recall.descendants), "registry_count": recall.remaining})
	if recall.target.Cancel != nil {
		recall.target.Cancel(reason)
	} else {
		utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "recallbyid: has nil cancel func, dispatch leaked", map[string]any{"dispatch_id": recall.targetID, "model": recall.target.Name})
	}
}

// defaultRecallReason names a recall whose recaller gave no reason.
const defaultRecallReason = "recall_agent"

// recallReasonOrDefault returns reason, or defaultRecallReason when it is empty.
func recallReasonOrDefault(reason string) string {
	if reason == "" {
		return defaultRecallReason
	}
	return reason
}
