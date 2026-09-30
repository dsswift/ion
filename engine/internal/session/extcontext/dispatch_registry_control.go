package extcontext

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// Owner-scoped control resolution shared by steer and recall. Both verbs
// resolve a target the same way: a live dispatch the caller owns is acted on;
// everything else resolves to exactly one of the outcomes below, so a caller
// can tell "it finished", "not yours", and "no such dispatch" apart.

// ControlMismatch reports a control request that missed a dispatch another
// registry in the process holds live. A list against the holding registry
// shows the dispatch running while this request cannot reach it: the
// disagreement the report exists to make visible. It carries identity and
// lifecycle only, never prompt or message content.
type ControlMismatch struct {
	// DispatchID is the identifier the request addressed (canonical or alias).
	DispatchID string
	// Operation is "steer" or "recall".
	Operation string
	// Outcome is the outcome the request returned.
	Outcome string
	// ResolvingRegistry and ResolvingGeneration identify the registry that
	// missed and its membership generation at the miss.
	ResolvingRegistry   uint64
	ResolvingGeneration uint64
	// HoldingRegistry and HoldingGeneration identify the registry that holds
	// the dispatch live, and its generation.
	HoldingRegistry   uint64
	HoldingGeneration uint64
	// HoldingSessionID is the session key the holding entry was registered
	// under, empty for a reserved placeholder.
	HoldingSessionID string
	// LifecycleState is the held dispatch's state: "reserved", "running", or
	// "suspended".
	LifecycleState string
}

// SetControlMismatchObserver receives every ControlMismatch this registry
// reports, called outside the registry lock. The session routes it to
// telemetry.
func (r *DispatchRegistry) SetControlMismatchObserver(observer func(ControlMismatch)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.mismatchObserver = observer
}

// missKind is how a control request resolved when its target is not a live
// dispatch the caller may act on.
type missKind int

const (
	missNotFound missKind = iota
	missCompleted
	missUnauthorized
)

// resolveMiss classifies a control request whose target is not live in this
// registry. A retained terminal entry the caller owns is "completed" (the
// request raced completion); one it does not own is "unauthorized". An
// identifier another registry holds live is "unauthorized" too, and is
// reported as a ControlMismatch. Anything else is "not found".
func (r *DispatchRegistry) resolveMiss(ownerID, id, operation, unauthorizedOutcome string) (missKind, *DispatchTerminalEntry) {
	r.mu.Lock()
	if e, ok := r.terminalEntryLocked(id); ok {
		owned := r.descendsFromLocked(e.DispatchID, e.ParentDispatchID, ownerID)
		r.mu.Unlock()
		if !owned {
			utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "control: finished dispatch not owned by caller", map[string]any{
				"operation": operation, "dispatch_id": id, "owner_dispatch_id": ownerID,
			})
			return missUnauthorized, nil
		}
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "control: target already finished", map[string]any{
			"operation": operation, "dispatch_id": id, "run_id": e.DispatchID, "status": e.Status,
		})
		return missCompleted, &e
	}
	resolvingGeneration := r.generation
	observer := r.mismatchObserver
	r.mu.Unlock()

	holder := liveRegistryFor(id)
	if holder == nil || holder == r {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "control: target not found", map[string]any{
			"operation": operation, "dispatch_id": id, "owner_dispatch_id": ownerID,
		})
		return missNotFound, nil
	}
	mismatch, held := holder.describeHeld(id)
	if !held {
		// Left the holding registry between the index read and this one.
		return r.resolveMissAfterRace(ownerID, id, operation)
	}
	mismatch.DispatchID = id
	mismatch.Operation = operation
	mismatch.Outcome = unauthorizedOutcome
	mismatch.ResolvingRegistry = r.seq
	mismatch.ResolvingGeneration = resolvingGeneration
	utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "control: dispatch is live in another registry", map[string]any{
		"operation": operation, "dispatch_id": id, "outcome": unauthorizedOutcome,
		"resolving_registry": mismatch.ResolvingRegistry, "resolving_generation": mismatch.ResolvingGeneration,
		"holding_registry": mismatch.HoldingRegistry, "holding_generation": mismatch.HoldingGeneration,
		"holding_session_id": mismatch.HoldingSessionID, "lifecycle_state": mismatch.LifecycleState,
	})
	if observer != nil {
		observer(mismatch)
	}
	return missUnauthorized, nil
}

// resolveMissAfterRace re-checks this registry's own history after the
// holding registry released the identifier. It never consults the index
// again, so it cannot loop.
func (r *DispatchRegistry) resolveMissAfterRace(ownerID, id, operation string) (missKind, *DispatchTerminalEntry) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.terminalEntryLocked(id); ok && r.descendsFromLocked(e.DispatchID, e.ParentDispatchID, ownerID) {
		return missCompleted, &e
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "control: target left its registry during resolution", map[string]any{
		"operation": operation, "dispatch_id": id,
	})
	return missNotFound, nil
}

// describeHeld fills the holding half of a ControlMismatch for id, or reports
// held=false when id is no longer live here.
func (r *DispatchRegistry) describeHeld(id string) (ControlMismatch, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	canonical, _, live := r.resolveIDLocked(id)
	if !live {
		return ControlMismatch{}, false
	}
	d := r.dispatches[canonical]
	return ControlMismatch{
		HoldingRegistry:   r.seq,
		HoldingGeneration: r.generation,
		HoldingSessionID:  d.SessionID,
		LifecycleState:    lifecycleState(d),
	}, true
}

func lifecycleState(d *activeDispatch) string {
	switch {
	case d.reserved:
		return "reserved"
	case d.Suspended:
		return "suspended"
	default:
		return "running"
	}
}
