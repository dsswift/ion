package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// Conversions from registry results to extension wire types. Both the
// per-context wiring (NewExtContext) and the session's idle-parent fallbacks
// build their responses here, so the two paths cannot drift.

// RecallAgentResult converts a name-addressed recall into its wire result.
func RecallAgentResult(r RecallControlResult) extension.RecallAgentResult {
	return extension.RecallAgentResult{
		Found:               r.Outcome == RecallOutcomeRecalled,
		Outcome:             string(r.Outcome),
		MatchingDispatchIDs: r.MatchingIDs,
		Terminal:            dispatchHistoryEntry(r.Terminal),
	}
}

// RecallDispatchResult converts an exact-ID recall into its wire result.
func RecallDispatchResult(r RecallControlResult) extension.RecallDispatchResult {
	return extension.RecallDispatchResult{
		Found:    r.Outcome == RecallOutcomeRecalled,
		Outcome:  string(r.Outcome),
		Terminal: dispatchHistoryEntry(r.Terminal),
	}
}

// SteerResult converts an owner-scoped steer into its wire result.
func SteerResult(r SteerControlResult) extension.SteerDispatchResult {
	return extension.SteerDispatchResult{
		Delivered:           r.Outcome == SteerOutcomeDelivered,
		Outcome:             string(r.Outcome),
		MatchingDispatchIDs: r.MatchingIDs,
		Terminal:            dispatchHistoryEntry(r.Terminal),
	}
}

func dispatchHistoryEntry(e *DispatchTerminalEntry) *extension.DispatchHistoryEntry {
	if e == nil {
		return nil
	}
	out := DispatchHistoryEntries([]DispatchTerminalEntry{*e})
	return &out[0]
}

// DispatchHistoryEntries converts retained terminal entries to wire entries.
// Always returns a non-nil slice.
func DispatchHistoryEntries(entries []DispatchTerminalEntry) []extension.DispatchHistoryEntry {
	out := make([]extension.DispatchHistoryEntry, len(entries))
	for i, e := range entries {
		out[i] = extension.DispatchHistoryEntry{
			DispatchID:          e.DispatchID,
			Name:                e.Name,
			Status:              e.Status,
			Reason:              e.Reason,
			ExitCode:            copyExitCode(e.ExitCode),
			ParentDispatchID:    e.ParentDispatchID,
			Depth:               e.Depth,
			StartedAt:           e.StartedAt.UTC().Format(time.RFC3339Nano),
			CompletedAt:         e.CompletedAt.UTC().Format(time.RFC3339Nano),
			DurationMs:          e.CompletedAt.Sub(e.StartedAt).Milliseconds(),
			ToolCount:           e.ToolCount,
			ChildConversationID: e.ChildConversationID,
		}
	}
	return out
}

func copyExitCode(code *int) *int {
	if code == nil {
		return nil
	}
	c := *code
	return &c
}
