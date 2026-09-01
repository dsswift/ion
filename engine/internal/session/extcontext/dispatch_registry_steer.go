package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Dispatch steering: the outcome enum, the narrow Steerable interface, and the
// two addressing verbs (SteerByID / SteerByName). Split from
// dispatch_registry.go for the file-size cap; same package, same lock, no API
// change.

// SteerDispatchOutcome is a string-typed enum describing how a
// SteerByID call was resolved. It mirrors the backend.SteerResult
// values with an additional "not_found" for registry-level misses.
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
)

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
// identified by its public dispatch ID. It looks up the registry entry,
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

// SteerByName delivers a steering message to a running background dispatch
// identified by its agent name. When several dispatches share a name it
// selects the MOST RECENTLY STARTED one (StartedAt, with the dispatch ID as a
// deterministic tiebreak for same-instant starts), then delegates to
// SteerByID. Returns SteerOutcomeNotFound when no dispatch with that name
// exists.
//
// Most-recent is the rule because it is the only one that matches how a
// name-addressed steer is actually meant: the caller re-dispatched an agent and
// is steering the dispatch it just created. Selection used to be the first
// entry a Go map-range happened to yield, which is randomized per iteration by
// the runtime — so with two live same-name dispatches the steer landed on a
// coin flip, and the same call could reach a different agent each time with no
// way for the caller to tell which. Ordering it makes the choice explainable
// and repeatable.
//
// Name addressing remains inherently ambiguous, and SteerByID is still the
// precise verb. This makes the ambiguity resolve predictably instead of
// randomly; it does not make a name a dispatch identity.
func (r *DispatchRegistry) SteerByName(name, message string) SteerDispatchOutcome {
	r.mu.Lock()
	var foundID string
	var foundAt time.Time
	candidates := 0
	for id, d := range r.dispatches {
		if d.Name != name {
			continue
		}
		candidates++
		// Strictly-later wins; on an exact StartedAt tie fall back to the
		// larger ID so the choice is total and stable rather than
		// map-order-dependent. Both dispatch IDs embed a millisecond
		// timestamp, so the larger string is also the later dispatch.
		if foundID == "" || d.StartedAt.After(foundAt) || (d.StartedAt.Equal(foundAt) && id > foundID) {
			foundID, foundAt = id, d.StartedAt
		}
	}
	r.mu.Unlock()

	if foundID == "" {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: not found", map[string]any{"model": name, "count": len(message), "steer_outcome_not_found": SteerOutcomeNotFound})
		return SteerOutcomeNotFound
	}

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "steerbyname: resolved to most recently started dispatch", map[string]any{
		"model": name, "run_id": foundID, "max": candidates, "started_at": foundAt.UTC().Format(time.RFC3339Nano),
	})
	return r.SteerByID(foundID, message)
}
