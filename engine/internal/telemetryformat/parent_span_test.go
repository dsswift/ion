package telemetryformat

import "testing"

// A frame keeps a span's parent in the correlation context; expanding it
// restores Event.ParentSpanID.
func TestExpandLiftsParentSpanID(t *testing.T) {
	in := Event{
		Name: "llm.call", Ts: "2026-09-23T10:00:00Z", SchemaVersion: FrameVersion, Component: "engine",
		Payload: map[string]any{"span_id": "00f067aa0ba902b7", "duration_ms": 1.0},
		Context: map[string]any{"parent_span_id": "1111222233334444"},
		TraceID: "4bf92f3577b34da6a3ce929d0e0e4736",
	}
	frame, err := Compact([]Event{in})
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	out, err := Expand(frame)
	if err != nil {
		t.Fatalf("Expand: %v", err)
	}
	if out[0].ParentSpanID != "1111222233334444" {
		t.Errorf("ParentSpanID = %q", out[0].ParentSpanID)
	}
}
