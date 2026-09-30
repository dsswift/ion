package extcontext

import (
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
)

// Conversions from registry results to extension wire types. Both the
// per-context wiring (NewExtContext) and the session's idle-parent fallbacks
// build their responses here, so the two paths cannot drift.

// RecallAgentResult converts a name-addressed Recall into its wire result.
func RecallAgentResult(outcome RecallOutcome, matching []string) extension.RecallAgentResult {
	return extension.RecallAgentResult{
		Found:               outcome == RecallOutcomeRecalled,
		Outcome:             string(outcome),
		MatchingDispatchIDs: matching,
	}
}

// SteerResult converts a steer outcome into its wire result. matching is the
// ambiguous-name ID list from SteerByName and nil otherwise.
func SteerResult(outcome SteerDispatchOutcome, matching []string) extension.SteerDispatchResult {
	return extension.SteerDispatchResult{
		Delivered:           outcome == SteerOutcomeDelivered,
		Outcome:             string(outcome),
		MatchingDispatchIDs: matching,
	}
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
			ExitCode:            e.ExitCode,
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
