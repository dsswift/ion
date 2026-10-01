package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const callerTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
const callerSpan = "00f067aa0ba902b7"

func TestNewRunTraceJoinsCallerTrace(t *testing.T) {
	traceID, span := newRunTrace("k", "r", &PromptOverrides{Traceparent: utils.FormatTraceparent(callerTrace, callerSpan)})
	if traceID != callerTrace || span.parentSpanID != callerSpan {
		t.Fatalf("trace/parent = %q/%q, want %q/%q", traceID, span.parentSpanID, callerTrace, callerSpan)
	}
	if !utils.IsValidSpanID(span.spanID) || span.spanID == callerSpan {
		t.Errorf("run span id = %q, want a fresh span id", span.spanID)
	}
}

func TestNewRunTraceStartsTraceWithoutValidCaller(t *testing.T) {
	for name, overrides := range map[string]*PromptOverrides{
		"no overrides":        nil,
		"empty traceparent":   {},
		"invalid traceparent": {Traceparent: "00-not-a-trace-01"},
	} {
		traceID, span := newRunTrace("k", "r", overrides)
		if !utils.IsValidTraceID(traceID) || traceID == callerTrace {
			t.Errorf("%s: trace = %q, want a fresh trace", name, traceID)
		}
		if span.parentSpanID != "" || !utils.IsValidSpanID(span.spanID) {
			t.Errorf("%s: span = %+v, want a root span", name, span)
		}
	}
}

// A run's exit records its span under the caller's span, in the caller's
// trace, before the run identity is cleared.
func TestEmitRunSpanLockedRecordsRunSpan(t *testing.T) {
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	s := &engineSession{telemetry: collector, conversationID: "conv-1"}
	traceID, span := newRunTrace("k", "run-1", &PromptOverrides{Traceparent: utils.FormatTraceparent(callerTrace, callerSpan)})
	s.setRunIdentity("run-1", traceID)
	s.setRunSpan(span)

	code := 0
	emitRunSpanLocked(s, "k", "run-1", &code, nil)

	events := collector.BufferedEvents()
	if len(events) != 1 || events[0].Name != runSpanEvent {
		t.Fatalf("events = %+v", events)
	}
	e := events[0]
	if e.TraceID != callerTrace || e.ParentSpanID != callerSpan || e.Payload["span_id"] != span.spanID {
		t.Errorf("trace/parent/span = %q/%q/%v", e.TraceID, e.ParentSpanID, e.Payload["span_id"])
	}
	if _, ok := e.Payload["duration_ms"].(float64); !ok {
		t.Errorf("duration_ms = %T", e.Payload["duration_ms"])
	}
	if e.Payload["span_kind"] != telemetry.SpanKindServer {
		t.Errorf("span_kind = %v, want the run to be the engine's server span", e.Payload["span_kind"])
	}

	emitRunSpanLocked(s, "k", "some-other-run", &code, nil)
	if n := len(collector.BufferedEvents()); n != 1 {
		t.Errorf("a stale run's exit emitted a span (events = %d)", n)
	}
}

// Regression: run.execute is a cost-bearing span sibling to llm.call/
// tool.execute/tool.failure (which all carry the acting principal's
// identity via backend.buildTelemCtx). run.execute used to build its
// context from correlationCtxExt alone, which never stamps
// "principal_identity" -- so the event fell through telemetry's
// identityForEvent to the process-wide operator identity (the engine's own
// AI Gateway sign-in) instead of the session's own person, disagreeing with
// every other span in the same run about who caused it.
func TestEmitRunSpanLockedStampsPrincipalIdentity(t *testing.T) {
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	s := &engineSession{telemetry: collector, conversationID: "conv-1", principal: &types.SessionPrincipal{Subject: "local:jdoe", DisplayName: "jdoe"}}
	traceID, span := newRunTrace("k", "run-1", nil)
	s.setRunIdentity("run-1", traceID)
	s.setRunSpan(span)

	code := 0
	emitRunSpanLocked(s, "k", "run-1", &code, nil)

	events := collector.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("events = %+v", events)
	}
	if got := events[0].User; got != "jdoe" {
		t.Errorf("run.execute User = %q, want the session principal's attribution %q", got, "jdoe")
	}
	if got, _ := events[0].Context["principal_identity"].(string); got != "jdoe" {
		t.Errorf(`run.execute Context["principal_identity"] = %q, want "jdoe"`, got)
	}
}

func TestClearRunIdentityClearsRunSpan(t *testing.T) {
	s := &engineSession{}
	s.setRunIdentity("run-1", callerTrace)
	s.setRunSpan(runSpan{spanID: callerSpan})
	s.clearRunIdentity()
	if got := s.runSpanSnapshot(); got.spanID != "" {
		t.Errorf("run span after clear = %+v", got)
	}
}
