package extcontext

import (
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Dispatch steering: the outcome enum, the narrow Steerable interface, and the
// two addressing verbs (SteerByID / SteerByName). Split from
// dispatch_registry.go for the file-size cap; same package, same lock, no API
// change.

// SteerDispatchOutcome is a string-typed enum describing how a
// SteerByID or SteerByName call was resolved. It mirrors the
// backend.SteerResult values with an additional "not_found" for
// registry-level misses and "ambiguous" for a name that matches more than one
// live dispatch.
type SteerDispatchOutcome string

const (
	// SteerOutcomeDelivered: the steer message was buffered on the child's
	// steer channel and will be injected at the next drainSteer checkpoint.
	SteerOutcomeDelivered SteerDispatchOutcome = "delivered"
	// SteerOutcomeChannelFull: the child's steer channel has 4 pending
	// messages; no room for another.
	SteerOutcomeChannelFull SteerDispatchOutcome = "channel_full"
	// SteerOutcomeNoRun: the dispatch exists in the registry but its child
	// backend has no active run matching the ChildRunID.
	SteerOutcomeNoRun SteerDispatchOutcome = "no_run"
	// SteerOutcomeNotFound: no dispatch with that ID exists in the registry.
	SteerOutcomeNotFound SteerDispatchOutcome = "not_found"
	// SteerOutcomeAmbiguous: a name matched more than one live dispatch the
	// caller owns. Nothing was delivered; the matching IDs come back with the
	// outcome so the caller can retry against one by ID.
	SteerOutcomeAmbiguous SteerDispatchOutcome = "ambiguous"
	// SteerOutcomeUnauthorized: the dispatch exists but the caller does not
	// own it (it is the caller itself, an ancestor, a sibling, another branch,
	// or another session's dispatch).
	SteerOutcomeUnauthorized SteerDispatchOutcome = "unauthorized"
	// SteerOutcomeCompleted: the caller owns the dispatch but it had already
	// finished. The terminal entry comes back with the outcome.
	SteerOutcomeCompleted SteerDispatchOutcome = "completed"
)

// SteerControlResult is the full result of an owner-scoped steer.
// MatchingIDs is set only for SteerOutcomeAmbiguous; Terminal only for
// SteerOutcomeCompleted.
type SteerControlResult struct {
	Outcome     SteerDispatchOutcome
	MatchingIDs []string
	Terminal    *DispatchTerminalEntry
}

// Steerable is a narrow interface for backends that support in-process
// steer delivery. Both *backend.ApiBackend and *backend.HybridBackend
// implement it. This mirrors the session-local steerable interface
// (session/agent.go) but is exported so the dispatch registry (a
// different package) can type-assert against it.
type Steerable interface {
	SteerWithReason(requestID, message string) backend.SteerResult
	SteerWithKind(requestID, message, kind string) backend.SteerResult
}

// SteerByID delivers a steering message to a running background dispatch
// identified by its public dispatch ID, with no ownership check. It is the
// engine's internal delivery verb; extension-facing steers go through
// SteerOwnedByID. It looks up the registry entry,
// type-asserts the stored Child backend to the Steerable interface, and
// calls SteerWithReason with the entry's ChildRunID. The backend's
// SteerResult is mapped to a SteerDispatchOutcome so the caller gets a
// four-value verdict: delivered, channel_full, no_run, or not_found.
func (r *DispatchRegistry) SteerByID(dispatchID, message string) SteerDispatchOutcome {
	return r.SteerByIDWithKind(dispatchID, message, "")
}

// SteerByIDWithKind is the classification-carrying variant of SteerByID.
//
// kind is a types.InjectionKind wire value naming who authored the message, so
// a completion or check-in steered into a live child run is persisted as the
// machine-to-machine turn it is rather than as an unclassified user turn.
func (r *DispatchRegistry) SteerByIDWithKind(dispatchID, message, kind string) SteerDispatchOutcome {
	r.mu.Lock()
	canonicalID, viaAlias, found := r.resolveIDLocked(dispatchID)
	if !found {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid: not found", map[string]any{"run_id": dispatchID, "count": len(message), "steer_outcome_not_found": SteerOutcomeNotFound})
		return SteerOutcomeNotFound
	}
	entry := r.dispatches[canonicalID]
	child := entry.Child
	childRunID := entry.ChildRunID
	name := entry.Name
	reserved := entry.reserved
	r.mu.Unlock()

	if viaAlias {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid: resolved consumer dispatch id through alias", map[string]any{
			"alias": dispatchID, "run_id": canonicalID, "model": name,
		})
	}

	// A reserved placeholder, or a registered entry whose child run has not
	// reported its run ID yet, is a dispatch that exists but is not yet
	// steerable. Report that as no_run — the honest, retryable answer — rather
	// than falling through to the interface assertion below, where a nil Child
	// would be reported as "child backend does not implement steerable". That
	// message named the wrong cause entirely: the backend type is irrelevant
	// when there is no backend yet, and a caller reading it would go looking
	// for a missing interface implementation instead of simply retrying.
	if child == nil || reserved || childRunID == "" {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid: dispatch registered but its child run has not started yet", map[string]any{
			"run_id": canonicalID, "model": name, "reserved": reserved, "has_child": child != nil, "child_run_id": childRunID, "steer_outcome_no_run": SteerOutcomeNoRun,
		})
		return SteerOutcomeNoRun
	}

	s, ok := child.(Steerable)
	if !ok {
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "steerbyid: child backend does not implement steerable", map[string]any{"run_id": canonicalID, "model": name, "steer_outcome_no_run": SteerOutcomeNoRun})
		return SteerOutcomeNoRun
	}

	result := s.SteerWithKind(childRunID, message, kind)
	var outcome SteerDispatchOutcome
	switch result {
	case backend.SteerResultDelivered:
		outcome = SteerOutcomeDelivered
	case backend.SteerResultChannelFull:
		outcome = SteerOutcomeChannelFull
	case backend.SteerResultNoRun:
		outcome = SteerOutcomeNoRun
	default:
		outcome = SteerOutcomeNoRun
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyid", map[string]any{"dispatch_id": canonicalID, "agent_name": name, "child_run_id": childRunID, "count": len(message), "result": result, "outcome": outcome})
	return outcome
}

// SteerOwnedByID steers the dispatch identified by dispatchID (canonical ID or
// consumer alias) on behalf of ownerID. The root context (empty ownerID) owns
// every dispatch in the registry; a dispatched agent owns only its strict
// descendants. A live owned dispatch gets the message through SteerByID; a
// live dispatch the caller does not own is SteerOutcomeUnauthorized; a
// finished one resolves through resolveMiss.
func (r *DispatchRegistry) SteerOwnedByID(ownerID, dispatchID, message string) SteerControlResult {
	r.mu.Lock()
	canonical, _, live := r.resolveIDLocked(dispatchID)
	if live {
		target := r.dispatches[canonical]
		owned := r.descendsFromLocked(canonical, target.ParentID, ownerID)
		r.mu.Unlock()
		if !owned {
			utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerownedbyid: caller does not own dispatch", map[string]any{
				"owner_dispatch_id": ownerID, "dispatch_id": dispatchID, "run_id": canonical,
			})
			return SteerControlResult{Outcome: SteerOutcomeUnauthorized}
		}
		if outcome := r.SteerByID(canonical, message); outcome != SteerOutcomeNotFound {
			return SteerControlResult{Outcome: outcome}
		}
		// Finished between the ownership check and delivery.
	} else {
		r.mu.Unlock()
	}
	return steerMissResult(r.resolveMiss(ownerID, dispatchID, "steer", string(SteerOutcomeUnauthorized)))
}

func steerMissResult(kind missKind, terminal *DispatchTerminalEntry) SteerControlResult {
	switch kind {
	case missCompleted:
		return SteerControlResult{Outcome: SteerOutcomeCompleted, Terminal: terminal}
	case missUnauthorized:
		return SteerControlResult{Outcome: SteerOutcomeUnauthorized}
	default:
		return SteerControlResult{Outcome: SteerOutcomeNotFound}
	}
}

// SteerOwnedByName steers the one live dispatch ownerID owns that carries
// name. It searches exactly the scope SteerOwnedByID would accept, so a name
// never reaches a dispatch its ID could not. When several owned dispatches
// carry the name it delivers nothing and returns SteerOutcomeAmbiguous with
// every matching ID, sorted: choosing one would put the message in front of
// an agent the caller may not have meant.
func (r *DispatchRegistry) SteerOwnedByName(ownerID, name, message string) SteerControlResult {
	r.mu.Lock()
	matches := r.ownedLiveIDsByNameLocked(ownerID, name)
	r.mu.Unlock()

	switch len(matches) {
	case 0:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: not found", map[string]any{"model": name, "owner_dispatch_id": ownerID, "count": len(message)})
		return SteerControlResult{Outcome: SteerOutcomeNotFound}
	case 1:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: resolved unique name match", map[string]any{"model": name, "owner_dispatch_id": ownerID, "run_id": matches[0]})
		return r.SteerOwnedByID(ownerID, matches[0], message)
	default:
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: ambiguous name, nothing delivered", map[string]any{"model": name, "owner_dispatch_id": ownerID, "max": len(matches), "dispatch_ids": matches})
		return SteerControlResult{Outcome: SteerOutcomeAmbiguous, MatchingIDs: matches}
	}
}
