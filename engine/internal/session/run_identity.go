package session

import (
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// runSpan is the engine's span for one run: its own span-id, the caller's
// span it runs under (from the prompt's traceparent, empty when the engine
// started the trace), and when the run was dispatched. Guarded by
// runIdentityMu with the run's other identifiers.
type runSpan struct {
	spanID       string
	parentSpanID string
	startedAt    time.Time
}

// newRunTrace picks the trace for a run being dispatched. A valid caller
// traceparent makes the run a child of the caller's span in the caller's
// trace; otherwise the engine starts a new trace with the run as its root.
func newRunTrace(key, runID string, overrides *PromptOverrides) (string, runSpan) {
	span := runSpan{spanID: utils.NewSpanID(), startedAt: time.Now()}
	traceparent := ""
	if overrides != nil {
		traceparent = overrides.Traceparent
	}
	traceID, parentSpanID, ok := utils.ParseTraceparent(traceparent)
	switch {
	case ok:
		span.parentSpanID = parentSpanID
		utils.LogWithFields(utils.LevelInfo, "session", "sendprompt: joined caller trace", map[string]any{"key": key, "run_id": runID, "trace_id": traceID, "span_id": span.spanID, "parent_span_id": parentSpanID})
		return traceID, span
	case traceparent != "":
		traceID = utils.NewTraceID()
		utils.LogWithFields(utils.LevelWarn, "session", "sendprompt: invalid caller traceparent; started a new trace", map[string]any{"key": key, "run_id": runID, "trace_id": traceID, "span_id": span.spanID, "traceparent": traceparent})
		return traceID, span
	default:
		traceID = utils.NewTraceID()
		utils.LogWithFields(utils.LevelDebug, "session", "sendprompt: no caller traceparent; started a new trace", map[string]any{"key": key, "run_id": runID, "trace_id": traceID, "span_id": span.spanID})
		return traceID, span
	}
}

// setRunIdentity updates one run's paired identifiers. Callers hold Manager.mu
// when the session is manager-owned; runIdentityMu also protects snapshots made
// by extension-context construction after manager lock release.
func (s *engineSession) setRunIdentity(runID, traceID string) {
	s.runIdentityMu.Lock()
	s.requestID = runID
	s.runTraceID = traceID
	if runID == "" {
		s.runSpan = runSpan{}
	}
	s.runIdentityMu.Unlock()
}

// setRunSpan records the span of the run setRunIdentity just assigned.
func (s *engineSession) setRunSpan(span runSpan) {
	s.runIdentityMu.Lock()
	s.runSpan = span
	s.runIdentityMu.Unlock()
}

func (s *engineSession) clearRunIdentity() {
	s.setRunIdentity("", "")
}

// clearRunIdentityFor clears only the run that still owns the session slot.
// Callers use this after work outside Manager.mu, where a newer run may already
// have started and must not be erased by the older run's cleanup.
func (s *engineSession) clearRunIdentityFor(runID string) bool {
	s.runIdentityMu.Lock()
	defer s.runIdentityMu.Unlock()
	if s.requestID != runID {
		return false
	}
	s.requestID = ""
	s.runTraceID = ""
	s.runSpan = runSpan{}
	return true
}

func (s *engineSession) runIdentitySnapshot() (string, string) {
	s.runIdentityMu.RLock()
	defer s.runIdentityMu.RUnlock()
	return s.requestID, s.runTraceID
}

func (s *engineSession) runSpanSnapshot() runSpan {
	s.runIdentityMu.RLock()
	defer s.runIdentityMu.RUnlock()
	return s.runSpan
}
