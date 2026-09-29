package session

import (
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runSpanEvent names the telemetry span covering one run, dispatch to exit.
// llm.call, tool.execute, and hook spans inside the run are its children.
const runSpanEvent = "run.execute"

// emitRunSpanLocked records the exiting run's span. Called from
// handleRunExit under Manager.mu, before the run identity is cleared.
func emitRunSpanLocked(s *engineSession, key, runID string, code *int, signal *string) {
	activeRunID, traceID := s.runIdentitySnapshot()
	span := s.runSpanSnapshot()
	if activeRunID != runID || span.spanID == "" {
		utils.LogWithFields(utils.LevelDebug, "session", "run span skipped: exiting run is not the session's active run", map[string]any{"key": key, "run_id": runID, "active_run_id": activeRunID})
		return
	}
	if s.telemetry == nil {
		return
	}
	payload := map[string]any{
		"span_id":     span.spanID,
		"duration_ms": float64(time.Since(span.startedAt).Microseconds()) / 1000.0,
		"model":       s.lastModel,
		// The run answers the caller's send_prompt, so it is the engine's
		// server span: the request a trace backend attributes to the engine.
		"span_kind": telemetry.SpanKindServer,
	}
	if code != nil {
		payload["exit_code"] = *code
		if *code != 0 {
			payload["error"] = "run exited with a non-zero code"
		}
	}
	if signal != nil {
		payload["signal"] = *signal
		payload["error"] = "run exited on signal " + *signal
	}
	ctx := stampPrincipalIdentity(withRunCorrelation(correlationCtxExt(key, s.conversationID, s.extensionName, s.extensionVersion), runID, traceID), s)
	if ctx != nil && span.parentSpanID != "" {
		ctx["parent_span_id"] = span.parentSpanID
	}
	s.telemetry.Event(runSpanEvent, payload, ctx)
	utils.LogWithFields(utils.LevelInfo, "session", "run span emitted", map[string]any{"key": key, "run_id": runID, "trace_id": traceID, "span_id": span.spanID, "parent_span_id": span.parentSpanID, "duration_ms": payload["duration_ms"]})
}
