package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Terminal dispatch history. A dispatch leaves the live map the moment it ends
// (Deregister, a recall, or RecallAll), and at that same instant a retained
// DispatchTerminalEntry is recorded under the same lock. A consumer asking
// "what finished, when, and how" therefore sees every dispatch, including one
// that started and ended between two of its polls.
//
// History is a separate view from Snapshot: Snapshot and OwnedSnapshot stay
// live-only, so a consumer reading in-flight work is unaffected.

// Terminal dispatch statuses. They match the terminal statuses the dispatch
// lifecycle writes onto the dispatch's agent-state row.
const (
	DispatchStatusDone      = "done"
	DispatchStatusError     = "error"
	DispatchStatusCancelled = "cancelled"
)

// DispatchOutcome is how a dispatch ended, supplied by the path that ends it.
type DispatchOutcome struct {
	// Status is one of DispatchStatusDone, DispatchStatusError, or
	// DispatchStatusCancelled.
	Status string
	// Reason is the terminal reason: the error text for "error", the recall
	// reason for "cancelled". Empty for a clean "done".
	Reason string
	// ExitCode is the dispatch result's exit code (0, 1, ExitCodeRecalled,
	// ExitCodeDeclined, ...).
	ExitCode int
}

// dispatchExitOutcome derives the registry outcome from a dispatch's exit
// state, using the same precedence the dispatch's terminal agent-state
// transition uses: recalled beats error beats done.
func dispatchExitOutcome(recalled bool, recallReason string, childErr error, exitCode int) DispatchOutcome {
	switch {
	case recalled:
		return DispatchOutcome{Status: DispatchStatusCancelled, Reason: recallReason, ExitCode: exitCode}
	case childErr != nil:
		return DispatchOutcome{Status: DispatchStatusError, Reason: childErr.Error(), ExitCode: exitCode}
	default:
		return DispatchOutcome{Status: DispatchStatusDone, ExitCode: exitCode}
	}
}

// DispatchTerminalEntry is one retained terminal dispatch. It keeps the
// identity and lineage fields of the live entry (ID, name, parent, depth), so
// a completed dispatch tree can be reconstructed after the fact.
type DispatchTerminalEntry struct {
	DispatchID          string
	Name                string
	ParentDispatchID    string
	Depth               int
	Status              string
	Reason              string
	ExitCode            int
	StartedAt           time.Time
	CompletedAt         time.Time
	ToolCount           int
	ChildConversationID string
}

// dispatchHistory is the bounded, completion-ordered terminal record store.
// Protected by DispatchRegistry.mu.
type dispatchHistory struct {
	// entries is ordered oldest completion first. Eviction trims the front.
	entries []DispatchTerminalEntry
	// limits bounds entries by count and age. Until SetHistoryLimits runs,
	// historyLimitsLocked substitutes the compiled defaults.
	limits    types.DispatchHistoryConfig
	limitsSet bool
}

// SetHistoryLimits configures the terminal-history bound, normally from the
// engine config's dispatchHistory block at session start. Applied immediately,
// so shrinking the bound evicts at once.
func (r *DispatchRegistry) SetHistoryLimits(cfg *types.DispatchHistoryConfig) {
	resolved := cfg.Resolved()
	r.mu.Lock()
	defer r.mu.Unlock()
	r.history.limits = resolved
	r.history.limitsSet = true
	evicted := r.pruneHistoryLocked(time.Now())
	utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history limits set", map[string]any{
		"max": resolved.MaxEntries, "max_age_ms": resolved.MaxAgeMs, "evicted": evicted,
	})
}

func (r *DispatchRegistry) historyLimitsLocked() types.DispatchHistoryConfig {
	if r.history.limitsSet {
		return r.history.limits
	}
	return (*types.DispatchHistoryConfig)(nil).Resolved()
}

// recordTerminalLocked retains d as a terminal entry and applies the bound.
// Caller must hold r.mu and must already have removed d from r.dispatches.
func (r *DispatchRegistry) recordTerminalLocked(d *activeDispatch, outcome DispatchOutcome, now time.Time) {
	limits := r.historyLimitsLocked()
	if limits.MaxEntries <= 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history disabled; terminal dispatch not retained", map[string]any{
			"run_id": d.ID, "status": outcome.Status,
		})
		return
	}
	r.history.entries = append(r.history.entries, DispatchTerminalEntry{
		DispatchID:          d.ID,
		Name:                d.Name,
		ParentDispatchID:    d.ParentID,
		Depth:               d.Depth,
		Status:              outcome.Status,
		Reason:              outcome.Reason,
		ExitCode:            outcome.ExitCode,
		StartedAt:           d.StartedAt,
		CompletedAt:         now,
		ToolCount:           d.ToolCount,
		ChildConversationID: d.ChildConvID,
	})
	evicted := r.pruneHistoryLocked(now)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "terminal dispatch retained", map[string]any{
		"run_id": d.ID, "model": d.Name, "status": outcome.Status, "reason": outcome.Reason,
		"exit_code": outcome.ExitCode, "count": len(r.history.entries), "evicted": evicted,
	})
}

// pruneHistoryLocked drops entries past the age bound, then the oldest entries
// past the count bound. Returns how many it dropped. Caller must hold r.mu.
func (r *DispatchRegistry) pruneHistoryLocked(now time.Time) int {
	limits := r.historyLimitsLocked()
	entries := r.history.entries
	drop := 0
	if limits.MaxAgeMs > 0 {
		cutoff := now.Add(-time.Duration(limits.MaxAgeMs) * time.Millisecond)
		for drop < len(entries) && entries[drop].CompletedAt.Before(cutoff) {
			drop++
		}
	}
	maxEntries := max(limits.MaxEntries, 0)
	if over := len(entries) - drop - maxEntries; over > 0 {
		drop += over
	}
	if drop == 0 {
		return 0
	}
	// Copy the survivors so the evicted prefix does not pin the backing array.
	r.history.entries = append([]DispatchTerminalEntry(nil), entries[drop:]...)
	return drop
}

// History returns every retained terminal dispatch, oldest completion first.
// The age bound is applied before reading, so an entry past its age is never
// returned even when no dispatch has ended since it aged out.
func (r *DispatchRegistry) History() []DispatchTerminalEntry {
	return r.OwnedHistory("")
}

// OwnedHistory returns the retained terminal dispatches ownerID may see, oldest
// completion first. The ownership rule is the live rule (ownsDispatchLocked):
// the root context (empty ownerID) sees every entry; a dispatched agent sees
// only its strict descendants. Lineage is walked through live and retained
// entries alike, because a finished grandchild's parent has often finished
// too. A link that is neither live nor retained fails closed.
func (r *DispatchRegistry) OwnedHistory(ownerID string) []DispatchTerminalEntry {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	if evicted := r.pruneHistoryLocked(now); evicted > 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history aged out on read", map[string]any{"evicted": evicted})
	}

	parents := make(map[string]string, len(r.history.entries))
	for _, e := range r.history.entries {
		parents[e.DispatchID] = e.ParentDispatchID
	}
	out := make([]DispatchTerminalEntry, 0, len(r.history.entries))
	for _, e := range r.history.entries {
		if ownerID == "" || r.historyDescendsFromLocked(e, ownerID, parents) {
			out = append(out, e)
		}
	}
	return out
}

// historyDescendsFromLocked reports whether terminal entry e is a strict
// descendant of ownerID. Caller must hold r.mu.
func (r *DispatchRegistry) historyDescendsFromLocked(e DispatchTerminalEntry, ownerID string, parents map[string]string) bool {
	if e.DispatchID == ownerID {
		return false
	}
	visited := map[string]bool{e.DispatchID: true}
	parentID := e.ParentDispatchID
	for parentID != "" {
		if parentID == ownerID {
			return true
		}
		if visited[parentID] {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "ownedhistory: ancestry cycle", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": e.DispatchID, "cycle_id": parentID})
			return false
		}
		visited[parentID] = true
		if live, ok := r.dispatches[parentID]; ok {
			parentID = live.ParentID
			continue
		}
		next, ok := parents[parentID]
		if !ok {
			return false
		}
		parentID = next
	}
	return false
}
