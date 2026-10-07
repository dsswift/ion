package mcp

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A tool call is one mcp.call span under the caller's enclosing span (the
// run's tool.execute), lasting until the server answers or the call fails;
// a failed call carries the error.
func TestCallToolSpanRecordsUnderCallerSpan(t *testing.T) {
	conn := connectHanging(t, 100*time.Millisecond)
	c := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const traceID, toolSpan = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"
	ctx := utils.WithSpanID(utils.WithTraceID(context.Background(), traceID), toolSpan)

	if _, err := conn.CallToolSpan(ctx, "stall", nil, c, SpanCorrelation(ctx, "sess-1", "conv-1")); err == nil {
		t.Fatal("expected the stalled call to time out")
	}

	events := c.BufferedEvents()
	if len(events) != 1 || events[0].Name != telemetry.McpCall {
		t.Fatalf("events = %+v, want one mcp.call", events)
	}
	e := events[0]
	if id, _ := e.Payload["span_id"].(string); !utils.IsValidSpanID(id) { //nolint:errcheck // a missing id fails here
		t.Fatalf("span_id = %v", e.Payload["span_id"])
	}
	if d, ok := e.Payload["duration_ms"].(float64); !ok || d < 100 {
		t.Fatalf("duration_ms = %v, want at least the 100ms call timeout", e.Payload["duration_ms"])
	}
	if e.TraceID != traceID || e.ParentSpanID != toolSpan {
		t.Fatalf("trace/parent = %s/%s, want %s/%s", e.TraceID, e.ParentSpanID, traceID, toolSpan)
	}
	if e.Payload["server"] != "hang" || e.Payload["tool"] != "stall" || e.Payload["error"] == nil {
		t.Fatalf("payload = %v", e.Payload)
	}
}
