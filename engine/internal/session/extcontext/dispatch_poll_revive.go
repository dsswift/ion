package extcontext

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// PollResultRecord is a finished poll's outcome, recorded on the dispatch that
// awaited it so the revived run is told what the verdict was.
//
// Signalling revive without carrying the payload is not enough: the dispatch
// resumes, drains an empty result set, and is handed the generic "no child
// results were recorded" prompt. The agent then reports that it never received
// a verdict -- which is exactly what happened, and which the delivery log line
// hid by saying "delivered".
type PollResultRecord struct {
	PollID   string
	Verdict  string
	Evidence string
}

// DeliverPollResult routes a finished Poll to the dispatch that is parked on
// it, records the verdict for the resume prompt, and signals that dispatch's
// revive channel when its wait set drains.
//
// This is the Poll analogue of DeliverTaskResult, and it exists for the same
// reason: a dispatched agent that starts a Poll and then parks is waiting on a
// verdict that arrives on the session, not on the dispatch. Routing the verdict
// only to the root left the dispatch — and every ancestor parked on it —
// blocked on a signal that never came, until the 30-minute park backstop fired
// and reported "waiting on []" because polls were in no wait set at all.
//
// Returns the owning dispatch ID (empty when no parked dispatch awaits this
// poll, which is the normal root-session case) and whether a revive was
// signalled. A non-empty owner with revived=false means the poll was recorded
// but the dispatch still awaits other work.
//
// Unlike DeliverTaskResult there is no settled-poll table. A poll is created by
// the run that awaits it, so the completion cannot precede the park the way a
// fast background command can; a poll with no parked owner belongs to the root
// and is delivered there by the caller.
func (r *DispatchRegistry) DeliverPollResult(pollID string, rec PollResultRecord) (string, bool) {
	r.mu.Lock()

	var owner *activeDispatch
	for _, d := range r.dispatches {
		if _, waiting := d.PendingPolls[pollID]; waiting {
			owner = d
			break
		}
	}

	if owner == nil {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "deliverpollresult: no parked dispatch awaits this poll", map[string]any{
			"poll_id": pollID,
		})
		return "", false
	}

	delete(owner.PendingPolls, pollID)
	rec.PollID = pollID
	owner.CompletedPollResults = append(owner.CompletedPollResults, rec)
	dispatchID := owner.ID
	remainingPolls := len(owner.PendingPolls)
	remainingTasks := len(owner.PendingTasks)
	remainingChildren := len(owner.PendingChildren)

	if owner.ReviveCh == nil || remainingPolls > 0 || remainingTasks > 0 || remainingChildren > 0 {
		r.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "deliverpollresult: poll recorded on dispatch, wait set not empty", map[string]any{
			"run_id": dispatchID, "poll_id": pollID, "count": remainingPolls,
			"awaiting_tasks": remainingTasks, "awaiting_children": remainingChildren,
			"armed": owner.ReviveCh != nil,
		})
		return dispatchID, false
	}

	ch := owner.ReviveCh
	owner.ReviveCh = nil
	owner.PendingPolls = nil
	r.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "deliverpollresult: wait set drained, signalling revive", map[string]any{
		"run_id": dispatchID, "poll_id": pollID,
	})
	select {
	case ch <- struct{}{}:
	default:
		utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "deliverpollresult: revive channel full or closed", map[string]any{
			"run_id": dispatchID, "poll_id": pollID,
		})
	}
	return dispatchID, true
}

// DepthOf reports the nesting depth of one dispatch, and whether it is known.
//
// The Poll driver needs it to parent a poll-check child correctly: a poll
// started by a dispatch at depth N spawns its judge at depth N+1, so the
// nesting guard counts the chain the operator actually sees. An unknown id
// (the root session, or a dispatch that already completed) reports false and
// the caller treats the poll as root-owned.
func (r *DispatchRegistry) DepthOf(id string) (int, bool) {
	if id == "" {
		return 0, false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	d, ok := r.dispatches[id]
	if !ok {
		return 0, false
	}
	return d.Depth, true
}

// DrainPollResults removes and returns the recorded poll verdicts for a
// dispatch. Called by runChild on revive so the resume prompt carries the
// verdict the agent was waiting for. Thread-safe.
func (r *DispatchRegistry) DrainPollResults(id string) []PollResultRecord {
	r.mu.Lock()
	defer r.mu.Unlock()

	d, ok := r.dispatches[id]
	if !ok || len(d.CompletedPollResults) == 0 {
		return nil
	}
	out := d.CompletedPollResults
	d.CompletedPollResults = nil
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "drainpollresults: drained poll verdicts", map[string]any{
		"run_id": id, "count": len(out),
	})
	return out
}
