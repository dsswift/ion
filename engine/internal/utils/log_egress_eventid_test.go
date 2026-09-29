package utils

import (
	"testing"
)

// TestEgressEnqueue_StampsUniqueEventID pins issue #310: every record shipped
// through the enqueue chokepoint (ship + shipTailed) gets a non-empty, unique
// event_id. Red on unfixed code (enqueue never stamped event_id).
func TestEgressEnqueue_StampsUniqueEventID(t *testing.T) {
	f := &EgressForwarder{
		shipOwn: true,
		buffer:  make([]egressRecord, 0, 8),
	}
	for i := 0; i < 5; i++ {
		f.ship(egressRecord{Ts: "t", Level: "INFO", Msg: "m", Component: "engine", Tag: "test"})
	}

	seen := map[string]bool{}
	for i, r := range f.buffer {
		if r.EventID == "" {
			t.Errorf("record %d has empty event_id", i)
		}
		if seen[r.EventID] {
			t.Errorf("record %d event_id %q is not unique", i, r.EventID)
		}
		seen[r.EventID] = true
	}
}

// TestEgressEnqueue_PreservesExistingEventID pins that a record already
// carrying an event_id (e.g. a tailed telemetry event) keeps it — the stamp
// only fills an absent id.
func TestEgressEnqueue_PreservesExistingEventID(t *testing.T) {
	f := &EgressForwarder{shipOwn: true, buffer: make([]egressRecord, 0, 2)}
	f.shipTailed(egressRecord{Ts: "t", Component: "engine", Name: "run.complete", Payload: map[string]any{"x": 1}, EventID: "preexisting123456"})
	if len(f.buffer) != 1 {
		t.Fatalf("expected 1 buffered record, got %d", len(f.buffer))
	}
	if f.buffer[0].EventID != "preexisting123456" {
		t.Errorf("existing event_id must be preserved, got %q", f.buffer[0].EventID)
	}
}

// TestOTLPAttrsIncludeEventID pins that the operational OTLP attribute mapper
// promotes event_id when present.
func TestOTLPAttrsIncludeEventID(t *testing.T) {
	attrs := otlpAttrsFromRecord(egressRecord{Component: "engine", Tag: "test", EventID: "abc123"})
	found := false
	for _, a := range attrs {
		if a.Key == "event_id" && a.Value.StringValue != nil && *a.Value.StringValue == "abc123" {
			found = true
		}
	}
	if !found {
		t.Error("otlpAttrsFromRecord must include event_id when present")
	}
}
