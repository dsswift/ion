package utils

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// makeTestForwarder builds a minimal EgressForwarder suitable for tailer tests.
// No flush goroutine is started, so records accumulate in the buffer and can be
// read by the test directly (same package access).
func makeTestForwarder(dir string) *EgressForwarder {
	return &EgressForwarder{
		cfg: types.LoggingConfig{
			EgressTargets:       []string{"http"},
			EgressEndpoint:      "http://localhost:0", // unreachable; flush never called
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
// JSON but no "msg" field) is shipped with the raw line as the record body.
// An empty body would cause the OTLP exporter to write a zero-content log
// record, silently losing all telemetry payload.
//
// Regression: pollFile previously unmarshaled telemetry lines into egressRecord
// (which maps "msg" → Msg), leaving Msg="" for every telemetry event because
// telemetry events use "name", not "msg".
func TestEgressTailerTelemetryBody(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()

	// Realistic run.complete telemetry event — no "msg" field.
	telemetryLine := `{"name":"run.complete","ts":"2026-07-10T21:00:00Z","schema":3,"component":"engine","install_id":"test-id","payload":{"run_cost_usd":0.25,"num_turns":3},"context":{"conversation_id":"test-conv","session_id":"test-sess"}}`
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

	// First record: telemetry event — Msg must be the full raw JSON line, not "".
	telRec := shipped[0]
	if telRec.Msg == "" {
		t.Error("telemetry record has empty Msg; want raw JSON line as body")
	}
	if !strings.Contains(telRec.Msg, "run.complete") {
		t.Errorf("telemetry record Msg does not contain event name; got: %q", telRec.Msg)
	}
	// Parsed struct fields (component) must still be populated.
	if telRec.Component != "engine" {
		t.Errorf("telemetry record Component = %q; want %q", telRec.Component, "engine")
	}

	// Sanity-check: the test line really has no "msg" field (otherwise the
	// fallback branch is never exercised).
	var probe map[string]any
	if err := json.Unmarshal([]byte(telemetryLine), &probe); err != nil {
		t.Fatalf("test telemetry line is not valid JSON: %v", err)
	}
	if _, hasMsgField := probe["msg"]; hasMsgField {
		t.Fatal("test telemetry line has a 'msg' field; test is not exercising the fallback branch")
	}

	// Second record: operational log — Msg is the "msg" field value.
	logRec := shipped[1]
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
