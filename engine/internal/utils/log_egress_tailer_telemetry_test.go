package utils

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/filetail"
	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

// tailOneFile runs one poll pass over a file and returns what was shipped.
func tailOneFile(t *testing.T, contents string) []egressRecord {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "telemetry.jsonl")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	forwarder := makeTestForwarder(dir)
	tailer := &EgressTailer{
		files:      map[string]string{"telemetry": path},
		cursorPath: filepath.Join(dir, "cursors.json"),
		fwd:        forwarder,
		cursors:    map[string]filetail.Cursor{path: {Initialized: true}},
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
	tailer.pollFile("telemetry", path)

	forwarder.mu.Lock()
	defer forwarder.mu.Unlock()
	shipped := make([]egressRecord, len(forwarder.buffer))
	copy(shipped, forwarder.buffer)
	return shipped
}

// TestEgressTailerExpandsTelemetryFrames is the live-bug regression. The
// telemetry file stores compact frames, which carry no top-level name or
// payload — so the operational path did not recognize them as telemetry and
// stuffed the whole frame JSON into Msg. Every event shipped as an unqueryable
// log line, and the remote cost/runs/extensions dashboards had nothing to read.
func TestEgressTailerExpandsTelemetryFrames(t *testing.T) {
	frameLine, err := telemetryformat.EncodeCompactLine([]telemetryformat.Event{
		{
			Name: "run.complete", Ts: "2026-03-20T12:00:00Z", SchemaVersion: telemetryformat.FrameVersion,
			Component: "engine", InstallID: "install-1", Host: "host-1", Version: "v1", EventID: "e1",
			Payload: map[string]any{"run_cost_usd": 0.25},
			Context: map[string]any{"conversation_id": "conv-1"},
		},
		{
			Name: "tool.execute", Ts: "2026-03-20T12:00:01Z", SchemaVersion: telemetryformat.FrameVersion,
			Component: "engine", InstallID: "install-1", Host: "host-1", Version: "v1",
			Payload: map[string]any{"tool": "Bash"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	shipped := tailOneFile(t, string(frameLine))

	if len(shipped) != 2 {
		t.Fatalf("shipped %d records, want 2 — one frame expands into one record per event", len(shipped))
	}
	for index, record := range shipped {
		if !isTelemetryEventRecord(record) {
			t.Errorf("record %d not recognized as telemetry (name=%q payload=%v) — the OTLP exporter would map it through the operational path",
				index, record.Name, record.Payload)
		}
		if record.Msg != "" {
			t.Errorf("record %d Msg = %q, want empty — raw frame JSON in msg is the bug this pins", index, record.Msg)
		}
		if record.InstallID != "install-1" || record.Host != "host-1" || record.Version != "v1" {
			t.Errorf("record %d lost interned identity: install_id=%q host=%q version=%q",
				index, record.InstallID, record.Host, record.Version)
		}
	}
	if shipped[0].Name != "run.complete" || shipped[0].Payload["run_cost_usd"] != 0.25 {
		t.Errorf("first record = %+v, want the run.complete cost payload intact", shipped[0])
	}
	if shipped[0].Context == nil || shipped[0].Context["conversation_id"] != "conv-1" {
		t.Errorf("first record lost its interned context: %v", shipped[0].Context)
	}
	if shipped[1].Name != "tool.execute" {
		t.Errorf("second record Name = %q, want tool.execute", shipped[1].Name)
	}
}

// TestEgressTailerDropsUndecodableFrame pins that a line recognized as a frame
// but not decodable is dropped rather than shipped raw. Shipping it would put
// unqueryable JSON in msg — the exact shape expansion exists to prevent.
func TestEgressTailerDropsUndecodableFrame(t *testing.T) {
	poison := `{"record":"telemetry.frame","schema":4,"identities":[],"contexts":[],"events":[{"i":7,"name":"n","ts":"t","payload":{}}]}` + "\n"
	good := `{"ts":"2026-03-20T12:00:02Z","level":"INFO","msg":"still shipping","component":"engine","tag":"t"}` + "\n"

	shipped := tailOneFile(t, poison+good)

	if len(shipped) != 1 {
		t.Fatalf("shipped %d records, want 1 (the frame dropped, the line after it kept)", len(shipped))
	}
	if shipped[0].Msg != "still shipping" {
		t.Errorf("shipped %+v, want the operational line following the dropped frame", shipped[0])
	}
}

// TestEgressTailerPassesExpandedEventThrough pins that a non-frame telemetry
// line is untouched by the expansion seam — an engine that has not adopted
// frames still ships its expanded events unchanged.
func TestEgressTailerPassesExpandedEventThrough(t *testing.T) {
	line := `{"name":"run.complete","ts":"2026-03-20T12:00:00Z","schema":3,"component":"engine","install_id":"i","host":"h","version":"v","payload":{"run_cost_usd":0.5}}` + "\n"

	shipped := tailOneFile(t, line)

	if len(shipped) != 1 {
		t.Fatalf("shipped %d records, want 1", len(shipped))
	}
	if !isTelemetryEventRecord(shipped[0]) || shipped[0].Name != "run.complete" {
		t.Errorf("shipped %+v, want the expanded event passed through intact", shipped[0])
	}
	if shipped[0].Msg != "" {
		t.Errorf("Msg = %q, want empty", shipped[0].Msg)
	}
}
