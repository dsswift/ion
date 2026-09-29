package telemetry

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/protobuf/proto"
)

// A span ends as a telemetry event that carries its own span_id and duration,
// with its parent lifted from the correlation context.
func TestSpanHandleRecordsSpanIdentity(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	span := c.StartSpanCtx("tool.execute", map[string]any{"tool": "Bash"}, map[string]any{
		"trace_id":       "4bf92f3577b34da6a3ce929d0e0e4736",
		"parent_span_id": "1111222233334444",
	})
	span.End(nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	e := events[0]
	if got := e.Payload["span_id"]; got != span.SpanID() || len(span.SpanID()) != 16 {
		t.Errorf("payload span_id = %v, handle span id = %q", got, span.SpanID())
	}
	if _, ok := e.Payload["duration_ms"].(float64); !ok {
		t.Errorf("duration_ms = %T", e.Payload["duration_ms"])
	}
	if e.ParentSpanID != "1111222233334444" || e.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("parent/trace = %q/%q", e.ParentSpanID, e.TraceID)
	}
}

// The OtelBridge exports a span event under the span-id and parent Ion
// assigned, so its OTLP span links to spans recorded elsewhere.
func TestOtelBridgeKeepsIonSpanIdentity(t *testing.T) {
	requests := make(chan *collectortrace.ExportTraceServiceRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read: %v", err)
			return
		}
		var export collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(payload, &export); err != nil {
			t.Errorf("unmarshal: %v", err)
			return
		}
		requests <- &export
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	bridge := NewOtelBridge(OtelConfig{Endpoint: server.URL, BatchSize: 1})
	t.Cleanup(func() {
		if err := bridge.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	end := time.Now().UTC()
	bridge.RecordEvent(Event{
		Name:         "llm.call",
		Ts:           end.Format(time.RFC3339Nano),
		TraceID:      "4bf92f3577b34da6a3ce929d0e0e4736",
		ParentSpanID: "1111222233334444",
		Payload:      map[string]any{"span_id": "00f067aa0ba902b7", "duration_ms": 250.0},
	})
	span := waitForOTLPRequest(t, requests).ResourceSpans[0].ScopeSpans[0].Spans[0]
	if !bytes.Equal(span.SpanId, []byte{0x00, 0xf0, 0x67, 0xaa, 0x0b, 0xa9, 0x02, 0xb7}) {
		t.Errorf("span id = %x", span.SpanId)
	}
	if !bytes.Equal(span.ParentSpanId, []byte{0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44}) {
		t.Errorf("parent span id = %x", span.ParentSpanId)
	}
	if got := time.Duration(span.EndTimeUnixNano - span.StartTimeUnixNano); got < 249*time.Millisecond || got > 251*time.Millisecond {
		t.Errorf("duration = %v, want 250ms", got)
	}
}
