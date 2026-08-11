package extcontext

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Registry surface added for the dispatch-lifecycle fixes (park-on-children,
// sub-agent policy, activity telemetry). Lives in its own file because
// dispatch_registry.go sits near the 800-line cap; same package, no API
// boundary.

// ChildIDsOf returns the dispatch IDs of the registry's live NON-DETACHED
// children whose ParentID equals parentID. This is the read the
// park-on-children seam (RunConfig.OutstandingChildDispatches) consults at
// the parent's turn boundary: a non-empty result parks the parent run
// instead of completing it.
//
// Detached children are excluded by definition — a dispatch marked detached
// (DispatchAgentOpts.Detached) is fire-and-forget by explicit caller intent,
// so it must not hold its parent open. Direct children only (no descendant
// walk): a grandchild holds its own parent open, and that parent in turn
// holds this one, so transitive liveness composes without a recursive read.
func (r *DispatchRegistry) ChildIDsOf(parentID string) []string {
	if parentID == "" {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var ids []string
	seen := make(map[string]struct{})
	for id, d := range r.dispatches {
		if d.ParentID == parentID && !d.Detached {
			ids = append(ids, id)
			seen[id] = struct{}{}
		}
	}
	// A child can finish while its parent is still working. Keep its exact ID
	// visible until the parent drains its recorded terminal result; otherwise a
	// parent ending its turn after the child deregisters would complete without
	// ever receiving the result. SetSuspendedState prunes already-recorded IDs
	// and immediately revives, so this is a precise delivery marker, not a
	// liveness guess.
	if parent, ok := r.dispatches[parentID]; ok {
		for _, result := range parent.CompletedChildResults {
			if _, exists := seen[result.ChildID]; !exists {
				ids = append(ids, result.ChildID)
			}
		}
	}
	return ids
}

// MarkDetached flags the dispatch as detached: excluded from its parent's
// ChildIDsOf result, so the parent's run completes at the turn boundary even
// while this child is still running (the pre-park-on-children behavior,
// preserved per call by DispatchAgentOpts.Detached). No-op when the id is
// not registered — the flag is set immediately after Reserve, so a miss
// means the dispatch was already torn down.
func (r *DispatchRegistry) MarkDetached(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "markdetached: not found (no-op)", map[string]any{"run_id": id})
		return
	}
	d.Detached = true
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "markdetached: dispatch excluded from parent park set", map[string]any{"run_id": id, "model": d.Name})
}

// SetSubAgentPolicy records the dispatch's sub-agent policy alongside its
// allowlist. The policy is a carry-forward constraint like AllowedSubAgents
// itself: it is read by checkDispatchEligibility when THIS dispatch later
// dispatches a child. "" preserves the historical semantics (allowlist
// enforced only when non-empty); "allowlist" enforces membership even when
// the list is empty (an empty list denies everything — the "leaf agent may
// dispatch nothing" intent); "unrestricted" explicitly opts out. No-op when
// the id is not registered.
func (r *DispatchRegistry) SetSubAgentPolicy(id, policy string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "setsubagentpolicy: not found (no-op)", map[string]any{"run_id": id, "reason": policy})
		return
	}
	d.SubAgentPolicy = policy
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "set sub agent policy", map[string]any{"run_id": id, "reason": policy})
}

// SubAgentPolicyForID returns the sub-agent policy recorded for the dispatch,
// and whether the dispatch exists. Read by the eligibility guard together
// with AllowedSubAgentsForID.
func (r *DispatchRegistry) SubAgentPolicyForID(id string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		return "", false
	}
	return d.SubAgentPolicy, true
}

// UpdateActivity records live activity telemetry on the dispatch entry so
// Snapshot / ext/list_dispatch_state can answer "alive, parked, or wedged?"
// without a new hot path: the dispatch's OnNormalized handler calls this at
// the same throttle cadence as its existing progress emitter. Keep-sentinels
// let the two call sites update independently: toolCount < 0 keeps the
// previous count (the progress emitter doesn't know it); lastWork == ""
// keeps the previous snippet (the lifecycle counter doesn't compute one).
// LastActivityAt is stamped unconditionally — the call itself is the proof
// of life.
func (r *DispatchRegistry) UpdateActivity(id string, toolCount int, lastWork string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		return
	}
	if toolCount >= 0 {
		d.ToolCount = toolCount
	}
	if lastWork != "" {
		d.LastWork = lastWork
	}
	d.LastActivityAt = time.Now()
}

// progressBumpable is the narrow interface a registry-held child backend
// must satisfy for BumpProgressForID to refresh its run-progress watchdog
// clock. *backend.ApiBackend and *backend.HybridBackend (via its inner API
// backend) both satisfy it; delegated-CLI backends do not and degrade to a
// no-op — they have no in-process watchdog to starve.
type progressBumpable interface {
	BumpRunProgress(requestID string)
}

// BumpProgressForID refreshes the run-progress watchdog clock of the run
// OWNED BY the dispatch identified by dispatchID. This is the nested-parent
// half of the watchdog-credit fix: a depth-2 child's events must keep its
// depth-1 dispatching parent alive (the parent's run blocks in a synchronous
// dispatch and emits nothing itself), and the parent's run is the registry
// entry's Child backend + ChildRunID — NOT the root session's main-loop run,
// which is what the session-level bump reaches. Returns true when a bump was
// delivered; false when the dispatch is unknown, still a reservation
// (placeholder Child), or its backend is not progress-bumpable. Both failure
// shapes are DEBUG-logged so the credit chain is reconstructible.
func (r *DispatchRegistry) BumpProgressForID(dispatchID string) bool {
	r.mu.Lock()
	d, ok := r.dispatches[dispatchID]
	var child interface{}
	var childRunID string
	if ok {
		child = d.Child
		childRunID = d.ChildRunID
	}
	r.mu.Unlock()

	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "bumpprogressforid: dispatch not found", map[string]any{"run_id": dispatchID})
		return false
	}
	pb, isBumpable := child.(progressBumpable)
	if !isBumpable || childRunID == "" {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "bumpprogressforid: backend not bumpable or run id unset", map[string]any{"run_id": dispatchID, "reason": childRunID})
		return false
	}
	pb.BumpRunProgress(childRunID)
	return true
}

// ChildResultRecord captures a completed child dispatch's outcome on its
// parent's registry entry, so the parent's revive (or live steer) can inject
// the actual result instead of the parent being restarted blind. Without
// this, a revived parent replayed its original task from the top — it had no
// memory of the child completing and re-dispatched it in a loop (the
// 1785418884327 incident).
type ChildResultRecord struct {
	// ChildID is the completed child's dispatch ID.
	ChildID string
	// Name is the child's agent name.
	Name string
	// Output is the child's terminal output (bounded; see maxChildResultLen).
	Output string
	// ExitCode is the child's exit code (0 success, 1 error, 2 recalled).
	ExitCode int
}

// maxChildResultLen bounds a recorded child output so a pathological child
// cannot balloon its parent's registry entry. Generous — the result is the
// entire point of the record; truncation appends a marker naming the child
// conversation as the full-text source.
const maxChildResultLen = 48 * 1024

// RecordChildResult appends a completed child's outcome to its parent's
// registry entry. Called on the child's terminal path BEFORE the parent is
// notified/revived, so the revive prompt always sees it. No-op when the
// parent is unknown (already terminal — its own consumer owns the result
// then). Thread-safe.
func (r *DispatchRegistry) RecordChildResult(parentID string, rec ChildResultRecord) bool {
	if len(rec.Output) > maxChildResultLen {
		rec.Output = rec.Output[:maxChildResultLen] + "\n[... truncated; read the child conversation for the full output]"
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[parentID]
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "recordchildresult: parent not found (no-op)", map[string]any{"run_id": parentID, "reason": rec.ChildID})
		return false
	}
	d.CompletedChildResults = append(d.CompletedChildResults, rec)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "recordchildresult: child result recorded on parent", map[string]any{"run_id": parentID, "reason": rec.ChildID, "model": rec.Name, "status": rec.ExitCode, "count": len(d.CompletedChildResults)})
	return true
}

// PeekChildResults returns a snapshot of pending child results plus an
// acknowledgement closure. Acknowledge removes exactly this prefix only after
// the caller has durably persisted delivery, so a failed save cannot erase a
// completion or duplicate a later retry's in-memory turn.
func (r *DispatchRegistry) PeekChildResults(id string) ([]ChildResultRecord, func()) {
	r.mu.Lock()
	d, ok := r.dispatches[id]
	if !ok || len(d.CompletedChildResults) == 0 {
		r.mu.Unlock()
		return nil, func() {}
	}
	out := append([]ChildResultRecord(nil), d.CompletedChildResults...)
	r.mu.Unlock()

	var once sync.Once
	return out, func() {
		once.Do(func() {
			r.mu.Lock()
			defer r.mu.Unlock()
			current, ok := r.dispatches[id]
			if !ok || len(current.CompletedChildResults) == 0 {
				return
			}
			ackCount := len(out)
			if ackCount > len(current.CompletedChildResults) {
				ackCount = len(current.CompletedChildResults)
			}
			current.CompletedChildResults = current.CompletedChildResults[ackCount:]
		})
	}
}

// DrainChildResults returns and clears the recorded child results for the
// dispatch. It remains for parked-dispatch resume, where no separate durable
// checkpoint follows the read. Active run-loop delivery uses PeekChildResults
// and acknowledges only after saving the conversation.
func (r *DispatchRegistry) DrainChildResults(id string) []ChildResultRecord {
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok || len(d.CompletedChildResults) == 0 {
		return nil
	}
	out := d.CompletedChildResults
	d.CompletedChildResults = nil
	return out
}
