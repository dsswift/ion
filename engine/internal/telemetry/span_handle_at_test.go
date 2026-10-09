package telemetry

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// A span timed before the collector existed records its true start and end
// through StartSpanCtxAt / EndAt: the event's ts is the given end and the
// duration is end minus start, not the instants of the calls.
func TestSpanHandleRecordsRetroactiveTiming(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	start := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	end := start.Add(250 * time.Millisecond)
	span := c.StartSpanCtxAt(ConfigLoad, map[string]any{"path": "/x/engine.json"}, map[string]any{"trace_id": "4bf92f3577b34da6a3ce929d0e0e4736"}, start).WithSpanID("00f067aa0ba902b7")
	span.EndAt(end, nil)

	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("events = %d, want 1", len(events))
	}
	e := events[0]
	if e.Ts != end.Format(time.RFC3339Nano) {
		t.Errorf("ts = %s, want the span's end %s", e.Ts, end.Format(time.RFC3339Nano))
	}
	if got := e.Payload["duration_ms"]; got != 250.0 {
		t.Errorf("duration_ms = %v, want 250", got)
	}
	if e.Payload["span_id"] != "00f067aa0ba902b7" {
		t.Errorf("span_id = %v, want the id WithSpanID set", e.Payload["span_id"])
	}
	if e.Name != "config.load" || e.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Errorf("name/trace = %s/%s", e.Name, e.TraceID)
	}
}

// WithSpanID ignores an invalid id and keeps the minted one.
func TestSpanHandleWithSpanIDRejectsInvalid(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	span := c.StartSpanCtx(SessionStart, nil, nil)
	minted := span.SpanID()
	if span.WithSpanID("nope").SpanID() != minted {
		t.Fatalf("an invalid id replaced the minted span id")
	}
}

// system.metrics carries the runtime figures and a process row's session.
func TestSystemMetricsPayloadCarriesRuntimeFiguresAndSession(t *testing.T) {
	payload := SystemMetricsPayload(types.SystemMetricsSample{
		Processes: []types.SystemMetricsProcess{{Role: "mcp", Name: "fs", SessionID: "sess-1"}, {Role: "engine", Name: "ion"}},
		Runtime:   types.SystemMetricsRuntime{GCPauseP99Ms: 1.25, AllocRateBytesPerS: 512, SchedLatencyP99Ms: 0.5},
	})
	rt := payload["runtime"].(map[string]any)
	if rt["gc_pause_p99_ms"] != 1.25 || rt["alloc_rate_bytes_per_s"] != 512.0 || rt["sched_latency_p99_ms"] != 0.5 {
		t.Fatalf("runtime = %v", rt)
	}
	procs := payload["processes"].([]map[string]any)
	if procs[0]["session_id"] != "sess-1" {
		t.Fatalf("mcp row session_id = %v, want sess-1", procs[0]["session_id"])
	}
	if _, has := procs[1]["session_id"]; has {
		t.Fatalf("the engine's own row must carry no session_id: %v", procs[1])
	}
}
