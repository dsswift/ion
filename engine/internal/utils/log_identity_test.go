package utils

import (
	"testing"
)

func TestGetMachineIdentity_HostNonEmpty(t *testing.T) {
	t.Parallel()
	id := getMachineIdentity()
	// os.Hostname() always succeeds on every platform we support.
	if id.Host == "" {
		t.Error("expected Host to be non-empty")
	}
}

func TestAmbientFieldsFromIdentity_EmptyStringsExcluded(t *testing.T) {
	t.Parallel()
	id := machineIdentity{
		Host:        "myhost",
		MachineID:   "",       // empty — must be absent
		MDMDeviceID: "",       // empty — must be absent
		MDMSerial:   "",       // empty — must be absent
	}
	fields := ambientFieldsFromIdentity(id)
	if _, ok := fields["machine_id"]; ok {
		t.Error("machine_id must be absent when MachineID is empty")
	}
	if _, ok := fields["mdm_device_id"]; ok {
		t.Error("mdm_device_id must be absent when MDMDeviceID is empty")
	}
	if _, ok := fields["mdm_serial"]; ok {
		t.Error("mdm_serial must be absent when MDMSerial is empty")
	}
	if v, ok := fields["host"]; !ok || v != "myhost" {
		t.Errorf("host must be present and correct, got %v", v)
	}
}

func TestAmbientFieldsFromIdentity_AllPresent(t *testing.T) {
	t.Parallel()
	id := machineIdentity{
		Host:        "box",
		MachineID:   "uuid-123",
		MDMDeviceID: "mdm-id-456",
		MDMSerial:   "SER789",
	}
	fields := ambientFieldsFromIdentity(id)
	for _, key := range []string{"host", "machine_id", "mdm_device_id", "mdm_serial"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("expected field %q to be present", key)
		}
	}
}

func TestEgressForwarder_AmbientFieldsMerge_CallerWins(t *testing.T) {
	t.Parallel()
	// Build a minimal forwarder with known ambient fields (no real egress targets).
	// We test the merge logic via enqueue directly without flushing.
	f := &EgressForwarder{
		ambientFields: map[string]any{
			"host":       "ambient-host",
			"machine_id": "ambient-machine",
		},
		buffer:     make([]egressRecord, 0, 8),
		loggedErrs: make(map[string]bool),
		stopCh:     make(chan struct{}),
		flushDone:  make(chan struct{}),
	}

	// Caller supplies host — it must win over ambient.
	rec := egressRecord{
		Fields: map[string]any{
			"host": "caller-host",
		},
	}
	f.enqueue(rec)

	if len(f.buffer) != 1 {
		t.Fatalf("expected 1 buffered record, got %d", len(f.buffer))
	}
	got := f.buffer[0]
	if got.Fields["host"] != "caller-host" {
		t.Errorf("caller host must win: got %v", got.Fields["host"])
	}
	// Ambient-only key must be filled in.
	if got.Fields["machine_id"] != "ambient-machine" {
		t.Errorf("ambient machine_id must fill absent key: got %v", got.Fields["machine_id"])
	}
}

func TestEgressForwarder_AmbientFieldsMerge_NilFields(t *testing.T) {
	t.Parallel()
	f := &EgressForwarder{
		ambientFields: map[string]any{"host": "h"},
		buffer:        make([]egressRecord, 0, 4),
		loggedErrs:    make(map[string]bool),
		stopCh:        make(chan struct{}),
		flushDone:     make(chan struct{}),
	}
	// Record with nil Fields — ambient should be applied.
	f.enqueue(egressRecord{Fields: nil})

	if len(f.buffer) != 1 {
		t.Fatalf("expected 1 buffered record, got %d", len(f.buffer))
	}
	if f.buffer[0].Fields["host"] != "h" {
		t.Errorf("ambient host must populate nil Fields map: got %v", f.buffer[0].Fields)
	}
}
