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

// TestEgressEnqueue_MergesInstallIDAmbient pins that install_id is merged into
// egress records from the ambient identity fields, and that machine_id is
// unchanged (both ship — distinct identifiers).
func TestEgressEnqueue_MergesInstallIDAmbient(t *testing.T) {
	f := &EgressForwarder{
		shipOwn: true,
		buffer:  make([]egressRecord, 0, 2),
		ambientFields: map[string]any{
			"machine_id": "hw-uuid-1234",
			"install_id": "install-uuid-5678",
		},
	}
	f.ship(egressRecord{Ts: "t", Level: "INFO", Msg: "m", Component: "engine", Tag: "test"})
	if len(f.buffer) != 1 {
		t.Fatalf("expected 1 buffered record, got %d", len(f.buffer))
	}
	fields := f.buffer[0].Fields
	if fields["install_id"] != "install-uuid-5678" {
		t.Errorf("install_id ambient must be merged: got %v", fields["install_id"])
	}
	if fields["machine_id"] != "hw-uuid-1234" {
		t.Errorf("machine_id ambient must be unchanged: got %v", fields["machine_id"])
	}
}

// TestAmbientFieldsIncludeInstallID pins that ambientFieldsFromIdentity emits
// install_id alongside machine_id (distinct identifiers).
func TestAmbientFieldsIncludeInstallID(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	ResetInstallIDForTest()

	m := ambientFieldsFromIdentity(machineIdentity{Host: "h", MachineID: "hw-id"})
	if m["install_id"] == nil || m["install_id"] == "" {
		t.Error("ambient fields must include a non-empty install_id")
	}
	if m["machine_id"] != "hw-id" {
		t.Errorf("machine_id must be unchanged: got %v", m["machine_id"])
	}
	// install_id must equal the shared accessor's value.
	if m["install_id"] != InstallID() {
		t.Errorf("ambient install_id %v must match utils.InstallID() %v", m["install_id"], InstallID())
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
