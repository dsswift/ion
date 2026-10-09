package session

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// stampRunTrace fills the event's trace position from the session's active
// run when the event belongs to that run and carries none yet. An event for
// a run that is no longer the session's active run (a late event after exit)
// is left as it arrived: inventing the newer run's trace for it would mislabel
// it.
func stampRunTrace(s *engineSession, runID string, event types.NormalizedEvent) types.NormalizedEvent {
	if event.TraceID != "" && event.SpanID != "" {
		return event
	}
	activeRunID, traceID := s.runIdentitySnapshot()
	if activeRunID != runID || traceID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "normalized event left without run trace", map[string]any{"run_id": runID, "active_run_id": activeRunID, "event_type": event.Type()})
		return event
	}
	return event.WithTrace(traceID, s.runSpanSnapshot().spanID)
}
