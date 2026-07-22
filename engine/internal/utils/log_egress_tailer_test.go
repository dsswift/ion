package utils

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// makeTestForwarder builds a minimal EgressForwarder suitable for tailer tests.
// No flush goroutine is started, so records accumulate in the buffer and can be
// read by the test directly (same package access).
func makeTestForwarder(dir string) *EgressForwarder {
	return &EgressForwarder{
		cfg: types.LoggingConfig{
			EgressTargets:         []string{"http"},
			EgressEndpoint:        "http://localhost:0", // unreachable; flush never called
			EgressFlushIntervalMs: 60000,
		},
		shipOwn:    true,
		spoolPath:  filepath.Join(dir, "spool.jsonl"),
		spoolMaxB:  defaultSpoolMaxBytes,
		buffer:     make([]egressRecord, 0, 16),
		loggedErrs: make(map[string]bool),
		stopCh:     make(chan struct{}),
		flushDone:  make(chan struct{}),
	}
}

// TestEgressTailerTelemetryBody verifies that a telemetry event line (valid
// JSON with "name"+"payload", no "msg") is parsed into the telemetry carrier
// fields (Name/Payload/Context/Schema/InstallID) so the OTLP exporter maps it
// through the file-tail-parity path. Msg stays empty — the exporter reads the
// carrier fields, not Msg, for telemetry events.
//
// Regression: pollFile previously stuffed the raw JSON line into Msg
// (rec.Msg = line), which the OTLP exporter then wrapped as an operational log
// record whose escaped msg the remote ion_otlp_unwrap pipeline could not
// classify as telemetry (name buried inside the msg string).
func TestEgressTailerTelemetryBody(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	// Realistic run.complete telemetry event — no "msg" field.
	telemetryLine := `{"name":"run.complete","ts":"2026-07-10T21:00:00Z","schema":3,"component":"engine","install_id":"test-id","host":"jolteon","event_id":"abc123","version":"dev","payload":{"run_cost_usd":0.25,"num_turns":3},"context":{"conversation_id":"test-conv","session_id":"test-sess"}}`
	// Operational log line — has "msg".
	logLine := `{"ts":"2026-07-10T21:00:01Z","level":"INFO","msg":"session started","component":"engine","tag":"session"}`

	logPath := filepath.Join(dir, "telemetry.jsonl")
	if err := os.WriteFile(logPath, []byte(telemetryLine+"\n"+logLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	fwd := makeTestForwarder(dir)
	tailer := &EgressTailer{
		files:      map[string]string{"telemetry": logPath},
		cursorPath: filepath.Join(dir, "cursors.json"),
		fwd:        fwd,
		cursors:    map[string]int64{logPath: 0}, // start from top
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}

	tailer.pollFile("telemetry", logPath)

	fwd.mu.Lock()
	shipped := make([]egressRecord, len(fwd.buffer))
	copy(shipped, fwd.buffer)
	fwd.mu.Unlock()

	if len(shipped) != 2 {
		t.Fatalf("expected 2 shipped records, got %d", len(shipped))
	}

	// First record: telemetry event — carrier fields populated, Msg empty.
	telRec := shipped[0]
	if !isTelemetryEventRecord(telRec) {
		t.Error("first record not recognized as a telemetry event")
	}
	if telRec.Name != "run.complete" {
		t.Errorf("telemetry record Name = %q; want %q", telRec.Name, "run.complete")
	}
	if telRec.Msg != "" {
		t.Errorf("telemetry record Msg = %q; want empty (carrier fields hold the event)", telRec.Msg)
	}
	if telRec.Payload == nil || telRec.Payload["run_cost_usd"] != 0.25 {
		t.Errorf("telemetry record Payload run_cost_usd = %v; want 0.25", telRec.Payload["run_cost_usd"])
	}
	if telRec.Context == nil || telRec.Context["conversation_id"] != "test-conv" {
		t.Errorf("telemetry record Context conversation_id = %v; want test-conv", telRec.Context["conversation_id"])
	}
	if telRec.InstallID != "test-id" {
		t.Errorf("telemetry record InstallID = %q; want %q", telRec.InstallID, "test-id")
	}
	if telRec.Host != "jolteon" {
		t.Errorf("telemetry record Host = %q; want %q", telRec.Host, "jolteon")
	}
	if telRec.EventID != "abc123" {
		t.Errorf("telemetry record EventID = %q; want %q", telRec.EventID, "abc123")
	}
	// Parsed struct fields (component) must still be populated.
	if telRec.Component != "engine" {
		t.Errorf("telemetry record Component = %q; want %q", telRec.Component, "engine")
	}

	// Sanity-check: the test line really has no "msg" field.
	var probe map[string]any
	if err := json.Unmarshal([]byte(telemetryLine), &probe); err != nil {
		t.Fatalf("test telemetry line is not valid JSON: %v", err)
	}
	if _, hasMsgField := probe["msg"]; hasMsgField {
		t.Fatal("test telemetry line has a 'msg' field; test is not exercising the telemetry branch")
	}

	// Second record: operational log — Msg is the "msg" field value, not a
	// telemetry event.
	logRec := shipped[1]
	if isTelemetryEventRecord(logRec) {
		t.Error("operational log record misclassified as telemetry")
	}
	if logRec.Msg != "session started" {
		t.Errorf("log record Msg = %q; want %q", logRec.Msg, "session started")
	}
	if logRec.Level != "INFO" {
		t.Errorf("log record Level = %q; want %q", logRec.Level, "INFO")
	}
}

// TestEgressTailerNonJSONLine verifies that a non-JSON line is shipped with the
// raw line as the body and tag "tailer_raw", not silently dropped.
func TestEgressTailerNonJSONLine(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	logPath := filepath.Join(dir, "engine.jsonl")
	rawLine := "plain text log line, not JSON"
	if err := os.WriteFile(logPath, []byte(rawLine+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	fwd := makeTestForwarder(dir)
	tailer := &EgressTailer{
		files:      map[string]string{"engine": logPath},
		cursorPath: filepath.Join(dir, "cursors.json"),
		fwd:        fwd,
		cursors:    map[string]int64{logPath: 0},
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}

	tailer.pollFile("engine", logPath)

	fwd.mu.Lock()
	shipped := make([]egressRecord, len(fwd.buffer))
	copy(shipped, fwd.buffer)
	fwd.mu.Unlock()

	if len(shipped) != 1 {
		t.Fatalf("expected 1 shipped record, got %d", len(shipped))
	}
	rec := shipped[0]
	if rec.Msg != rawLine {
		t.Errorf("non-JSON record Msg = %q; want %q", rec.Msg, rawLine)
	}
	if rec.Tag != "tailer_raw" {
		t.Errorf("non-JSON record Tag = %q; want %q", rec.Tag, "tailer_raw")
	}
}
