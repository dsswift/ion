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

// TestOTLPAttrsRecordKeysWinOverFields pins that a field named like one of the
// record's own attributes never becomes a second attribute with that key. A
// line logging the OS account as fields.user used to ship two "user"
// attributes, and the collector kept the field's value over the signed-in
// user's. Mirrored in packages/shared log-egress-otel.test.ts.
func TestOTLPAttrsRecordKeysWinOverFields(t *testing.T) {
	attrs := otlpAttrsFromRecord(egressRecord{
		Component: "engine", Tag: "test", User: "user@example.com", SessionID: "s-1",
		Fields: map[string]any{"user": "osuser", "session_id": "s-1", "tag": "other", "kept": "yes"},
	})
	counts := map[string]int{}
	values := map[string]string{}
	for _, a := range attrs {
		counts[a.Key]++
		if a.Value.StringValue != nil {
			values[a.Key] = *a.Value.StringValue
		}
	}
	for _, key := range []string{"user", "session_id", "tag"} {
		if counts[key] != 1 {
			t.Fatalf("%s attributes = %d, want 1", key, counts[key])
		}
	}
	if values["user"] != "user@example.com" || values["tag"] != "test" {
		t.Fatalf("record keys lost to fields: user=%q tag=%q", values["user"], values["tag"])
	}
	if values["kept"] != "yes" {
		t.Fatal("an unrelated field must still become an attribute")
	}
}
