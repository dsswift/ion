package telemetryformat

import (
	"fmt"
	"testing"
)

// benchEvents is one flush of telemetry: n events sharing one identity and a
// handful of correlation contexts, as a run's events do.
func benchEvents(n int) []Event {
	events := make([]Event, n)
	for i := range events {
		e := testEvent()
		e.Name = "tool.execute"
		e.Context = map[string]any{"session_id": fmt.Sprintf("session-%d", i%4), "run_id": "run-1"}
		e.Payload = map[string]any{"tool": "Read", "duration_ms": float64(i), "span_id": "00f067aa0ba902b7"}
		events[i] = e
	}
	return events
}

func BenchmarkTelemetryCompactEncode(b *testing.B) {
	events := benchEvents(100)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := EncodeCompactLine(events); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkTelemetryDecodeLine(b *testing.B) {
	line, err := EncodeCompactLine(benchEvents(100))
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := DecodeLine(line); err != nil {
			b.Fatal(err)
		}
	}
}
