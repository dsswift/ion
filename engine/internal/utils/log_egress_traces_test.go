package utils

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

const (
	testTraceID  = "4bf92f3577b34da6a3ce929d0e0e4736"
	testSpanID   = "00f067aa0ba902b7"
	testParentID = "1111222233334444"
)

func TestSpanFromRecordTelemetryEvent(t *testing.T) {
	rec := egressRecord{
		Ts:        "2026-09-23T10:00:01.5Z",
		Component: "engine",
		Name:      "llm.call",
		TraceID:   testTraceID,
		Payload:   map[string]any{"span_id": testSpanID, "duration_ms": 1500.0, "model": "m", "error": "boom"},
		Context:   map[string]any{"parent_span_id": testParentID, "run_id": "r1"},
	}
	sr, ok := spanFromRecord(rec)
	if !ok {
		t.Fatal("telemetry span event not recognized")
	}
	s := sr.span
	if sr.service != "ion-engine" || s.Name != "llm.call" || s.TraceID != testTraceID || s.SpanID != testSpanID || s.ParentSpanID != testParentID {
		t.Fatalf("span = %+v service=%s", s, sr.service)
	}
	end, _ := time.Parse(time.RFC3339Nano, rec.Ts) //nolint:errcheck // fixed test literal
	wantStart := fmt.Sprintf("%d", end.Add(-1500*time.Millisecond).UnixNano())
	if s.StartTimeUnixNano != wantStart || s.EndTimeUnixNano != fmt.Sprintf("%d", end.UnixNano()) {
		t.Errorf("start/end = %s/%s", s.StartTimeUnixNano, s.EndTimeUnixNano)
	}
	if s.Status.Code != otlpStatusError || s.Status.Message != "boom" {
		t.Errorf("status = %+v", s.Status)
	}
	keys := map[string]bool{}
	for _, a := range s.Attributes {
		keys[a.Key] = true
	}
	if !keys["model"] || !keys["run_id"] || keys["span_id"] || keys["duration_ms"] {
		t.Errorf("attributes = %v", keys)
	}
}

func TestSpanFromRecordSpanLogLine(t *testing.T) {
	rec := egressRecord{
		Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "prompt.send", Component: "server", Tag: SpanLogTag,
		TraceID: testTraceID, ConversationID: "c1",
		Fields: map[string]any{"span_id": testSpanID, "parent_span_id": testParentID, "duration_ms": 12.0, "span_kind": "server"},
	}
	sr, ok := spanFromRecord(rec)
	if !ok {
		t.Fatal("span log line not recognized")
	}
	if sr.service != "ion-server" || sr.span.Kind != otlpSpanKindServer || sr.span.ParentSpanID != testParentID {
		t.Errorf("span = %+v service=%s", sr.span, sr.service)
	}
}

func TestSpanFromRecordRejectsNonSpans(t *testing.T) {
	cases := map[string]egressRecord{
		"plain log line":   {Ts: "2026-09-23T10:00:01Z", Msg: "hello", Tag: "session", TraceID: testTraceID},
		"telemetry point":  {Ts: "2026-09-23T10:00:01Z", Name: "run.complete", TraceID: testTraceID, Payload: map[string]any{"duration_ms": 5.0}},
		"missing trace":    {Ts: "2026-09-23T10:00:01Z", Name: "llm.call", Payload: map[string]any{"span_id": testSpanID, "duration_ms": 5.0}},
		"missing duration": {Ts: "2026-09-23T10:00:01Z", Name: "llm.call", TraceID: testTraceID, Payload: map[string]any{"span_id": testSpanID}},
		"span tag, bad id": {Ts: "2026-09-23T10:00:01Z", Msg: "x", Tag: SpanLogTag, TraceID: testTraceID, Fields: map[string]any{"span_id": "nope", "duration_ms": 1.0}},
		"unparseable ts":   {Ts: "yesterday", Name: "llm.call", TraceID: testTraceID, Payload: map[string]any{"span_id": testSpanID, "duration_ms": 5.0}},
	}
	for name, rec := range cases {
		if _, ok := spanFromRecord(rec); ok {
			t.Errorf("%s: recognized as a span", name)
		}
	}
}

// The otel target ships a batch's spans to /v1/traces, with the same
// headers as its logs, after the logs are accepted.
func TestFlushEgressToOtelShipsSpansAfterLogs(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var traces otlpTracesExportRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.URL.Path+" "+r.Header.Get("Authorization"))
		if r.URL.Path == "/v1/traces" {
			body, _ := io.ReadAll(r.Body) //nolint:errcheck // test server
			if err := json.Unmarshal(body, &traces); err != nil {
				t.Errorf("traces body: %v", err)
			}
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	records := []egressRecord{
		{Ts: "2026-09-23T10:00:01Z", Level: "INFO", Msg: "hello", Component: "engine", Tag: "session"},
		{Ts: "2026-09-23T10:00:01Z", Component: "engine", Name: "tool.execute", TraceID: testTraceID, Payload: map[string]any{"span_id": testSpanID, "duration_ms": 3.0}},
	}
	cfg := &types.OtelConfig{Endpoint: srv.URL, Headers: map[string]string{"Authorization": "Bearer t"}}
	if err := flushEgressToOtel(records, cfg, srv.Client()); err != nil {
		t.Fatalf("flush: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) != 2 || paths[0] != "/v1/logs Bearer t" || paths[1] != "/v1/traces Bearer t" {
		t.Fatalf("requests = %v", paths)
	}
	if len(traces.ResourceSpans) != 1 || len(traces.ResourceSpans[0].ScopeSpans[0].Spans) != 1 {
		t.Fatalf("traces = %+v", traces)
	}
}

// A rejected span export does not fail the flush: the logs already landed and
// a retry would ship them twice.
func TestFlushEgressToOtelSpanFailureDoesNotFailBatch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/traces" {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	records := []egressRecord{{Ts: "2026-09-23T10:00:01Z", Component: "engine", Name: "llm.call", TraceID: testTraceID, Payload: map[string]any{"span_id": testSpanID, "duration_ms": 3.0}}}
	if err := flushEgressToOtel(records, &types.OtelConfig{Endpoint: srv.URL}, srv.Client()); err != nil {
		t.Fatalf("flush returned %v, want nil", err)
	}
}
