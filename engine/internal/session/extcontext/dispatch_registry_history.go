package extcontext

import (
	"slices"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Terminal dispatch history. A dispatch leaves the live map the moment it ends
// (Deregister, a recall, or RecallAll), and at that same instant a retained
// DispatchTerminalEntry is recorded under the same lock. A consumer asking
// "what finished, when, and how" therefore sees every dispatch, including one
// that started and ended between two of its polls. The session persists each
// entry as it is recorded and seeds the next registry from disk, so history
// survives a session or engine restart (SeedHistory).
//
// History is a separate view from Snapshot: Snapshot and OwnedSnapshot stay
// live-only, so a consumer reading in-flight work is unaffected.

// Terminal dispatch statuses. done, error, and cancelled match the terminal
// statuses the dispatch lifecycle writes onto the dispatch's agent-state row.
// lost marks a dispatch that was in flight when the engine process died; it
// is only ever produced by rehydration.
const (
	DispatchStatusDone      = "done"
	DispatchStatusError     = "error"
	DispatchStatusCancelled = "cancelled"
	DispatchStatusLost      = "lost"
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
	DispatchID       string
	Name             string
	ParentDispatchID string
	Depth            int
	Status           string
	Reason           string
	// ExitCode is nil when the exit code is not known: a dispatch lost to an
	// engine restart, or one persisted before exit codes were recorded.
	ExitCode            *int
	StartedAt           time.Time
	CompletedAt         time.Time
	ToolCount           int
	ChildConversationID string
	// Aliases are the consumer-supplied identifiers the dispatch was known by
	// while live, so a control request that races completion and addresses
	// the consumer's key still finds the finished dispatch.
	Aliases []string
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

// SetTerminalObserver receives every terminal entry as the registry records
// it, called outside the registry lock. The session uses it to persist the
// entry so history survives a restart.
func (r *DispatchRegistry) SetTerminalObserver(observer func([]DispatchTerminalEntry)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.terminalObserver = observer
}

// SeedHistory loads terminal entries recovered from durable state into an
// empty history, ordered by completion and pruned to the current bound. It
// runs once at session start, before any dispatch can end. Entries whose ID
// is already retained are skipped.
func (r *DispatchRegistry) SeedHistory(entries []DispatchTerminalEntry) {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.historyLimitsLocked().MaxEntries <= 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history disabled; seed skipped", map[string]any{"count": len(entries)})
		return
	}
	seeded := 0
	for _, e := range entries {
		if _, exists := r.terminalEntryLocked(e.DispatchID); exists {
			continue
		}
		r.history.entries = append(r.history.entries, e)
		seeded++
	}
	slices.SortStableFunc(r.history.entries, func(a, b DispatchTerminalEntry) int {
		return a.CompletedAt.Compare(b.CompletedAt)
	})
	evicted := r.pruneHistoryLocked(now)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "history seeded from durable state", map[string]any{
		"count": seeded, "evicted": evicted, "max": len(r.history.entries),
	})
}

func (r *DispatchRegistry) historyLimitsLocked() types.DispatchHistoryConfig {
	if r.history.limitsSet {
		return r.history.limits
	}
	return (*types.DispatchHistoryConfig)(nil).Resolved()
}

// recordTerminalLocked builds d's terminal entry, retains it when history is
// on, and applies the bound. It returns the entry either way so the caller can
// hand it to the terminal observer. Caller must hold r.mu and must call it
// BEFORE leaveLocked, which drops the aliases recorded here.
func (r *DispatchRegistry) recordTerminalLocked(d *activeDispatch, outcome DispatchOutcome, now time.Time) DispatchTerminalEntry {
	exitCode := outcome.ExitCode
	entry := DispatchTerminalEntry{
		DispatchID:          d.ID,
		Name:                d.Name,
		ParentDispatchID:    d.ParentID,
		Depth:               d.Depth,
		Status:              outcome.Status,
		Reason:              outcome.Reason,
		ExitCode:            &exitCode,
		StartedAt:           d.StartedAt,
		CompletedAt:         now,
		ToolCount:           d.ToolCount,
		ChildConversationID: d.ChildConvID,
		Aliases:             r.aliasesForLocked(d.ID),
	}
	if r.historyLimitsLocked().MaxEntries <= 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history disabled; terminal dispatch not retained", map[string]any{
			"run_id": d.ID, "status": outcome.Status,
		})
		return entry
	}
	r.history.entries = append(r.history.entries, entry)
	evicted := r.pruneHistoryLocked(now)
	utils.LogWithFields(utils.LevelInfo, "session.extcontext.dispatch_registry", "terminal dispatch retained", map[string]any{
		"run_id": d.ID, "model": d.Name, "status": outcome.Status, "reason": outcome.Reason,
		"exit_code": outcome.ExitCode, "count": len(r.history.entries), "evicted": evicted,
	})
	return entry
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

// terminalEntryLocked finds the retained entry for id, matching the canonical
// ID first and then any alias the dispatch carried. The newest match wins.
// Caller must hold r.mu.
func (r *DispatchRegistry) terminalEntryLocked(id string) (DispatchTerminalEntry, bool) {
	for i := len(r.history.entries) - 1; i >= 0; i-- {
		if r.history.entries[i].DispatchID == id {
			return r.history.entries[i], true
		}
	}
	for i := len(r.history.entries) - 1; i >= 0; i-- {
		if slices.Contains(r.history.entries[i].Aliases, id) {
			return r.history.entries[i], true
		}
	}
	return DispatchTerminalEntry{}, false
}

// History returns every retained terminal dispatch, oldest completion first.
// The age bound is applied before reading, so an entry past its age is never
// returned even when no dispatch has ended since it aged out.
func (r *DispatchRegistry) History() []DispatchTerminalEntry {
	return r.OwnedHistory("")
}

// OwnedHistory returns the retained terminal dispatches ownerID may see, oldest
// completion first. The ownership rule is the live rule: the root context
// (empty ownerID) sees every entry; a dispatched agent sees only its strict
// descendants (descendsFromLocked).
func (r *DispatchRegistry) OwnedHistory(ownerID string) []DispatchTerminalEntry {
	now := time.Now()
	r.mu.Lock()
	defer r.mu.Unlock()
	if evicted := r.pruneHistoryLocked(now); evicted > 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext.dispatch_registry", "history aged out on read", map[string]any{"evicted": evicted})
	}

	out := make([]DispatchTerminalEntry, 0, len(r.history.entries))
	for _, e := range r.history.entries {
		if ownerID == "" || r.descendsFromLocked(e.DispatchID, e.ParentDispatchID, ownerID) {
			out = append(out, e)
		}
	}
	return out
}

// parentOfLocked returns the parent dispatch ID of a live or retained
// dispatch. known is false when the registry has no record of id at all.
// Caller must hold r.mu.
func (r *DispatchRegistry) parentOfLocked(id string) (parentID string, known bool) {
	if live, ok := r.dispatches[id]; ok {
		return live.ParentID, true
	}
	if e, ok := r.terminalEntryLocked(id); ok {
		return e.ParentDispatchID, true
	}
	return "", false
}

// descendsFromLocked reports whether the dispatch targetID, whose parent is
// parentID, is a strict descendant of ownerID. Lineage is walked through live
// and retained entries alike, because a finished grandchild's parent has often
// finished too. A link the registry has no record of fails closed. Caller must
// hold r.mu.
func (r *DispatchRegistry) descendsFromLocked(targetID, parentID, ownerID string) bool {
	if ownerID == "" {
		return true
	}
	if targetID == ownerID {
		return false
	}
	visited := map[string]bool{targetID: true}
	for parentID != "" {
		if parentID == ownerID {
			return true
		}
		if visited[parentID] {
			utils.LogWithFields(utils.LevelError, "session.extcontext.dispatch_registry", "ownership: ancestry cycle", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "cycle_id": parentID})
			return false
		}
		visited[parentID] = true
		next, known := r.parentOfLocked(parentID)
		if !known {
			utils.LogWithFields(utils.LevelWarn, "session.extcontext.dispatch_registry", "ownership: ancestor unknown, failing closed", map[string]any{"owner_dispatch_id": ownerID, "dispatch_id": targetID, "parent_dispatch_id": parentID})
			return false
		}
		parentID = next
	}
	return false
}
