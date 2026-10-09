package main

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

func TestExpandTelemetryExpandsMixedRecords(t *testing.T) {
	legacy := telemetryformat.Event{
		Name: "legacy.event", Ts: "2026-03-20T12:00:00Z", SchemaVersion: 3,
		Component: "engine", Payload: map[string]any{"source": "legacy"},
	}
	first := legacy
	first.Name = "frame.first"
	second := legacy
	second.Name = "frame.second"
	frame, err := telemetryformat.EncodeCompactLine([]telemetryformat.Event{first, second})
	if err != nil {
		t.Fatal(err)
	}
	legacyLine, err := telemetryformat.EncodeEventLine(legacy)
	if err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/telemetry.jsonl"
	if err := os.WriteFile(path, append(legacyLine, frame...), 0o600); err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	if err := expandTelemetry(path, &output); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != 3 {
		t.Fatalf("expanded line count = %d, want 3", len(lines))
	}
	var names []string
	var schemas []int
	for _, line := range lines {
		var event telemetryformat.Event
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatal(err)
		}
		names = append(names, event.Name)
		schemas = append(schemas, event.SchemaVersion)
	}
	if want := []string{"legacy.event", "frame.first", "frame.second"}; !equalStrings(names, want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	if want := []int{3, telemetryformat.FrameVersion, telemetryformat.FrameVersion}; !equalInts(schemas, want) {
		t.Fatalf("schemas = %v, want %v", schemas, want)
	}
}

// A v4 frame written by the previous engine still expands under the v5
// reader (version-forward), and its events keep reporting schema 4: the
// producer's number is evidence of which build wrote them.
func TestExpandTelemetryReadsV4Frame(t *testing.T) {
	v4 := `{"record":"telemetry.frame","schema":4,` +
		`"identities":[{"component":"engine","install_id":"i","host":"h","version":"v4-build","user":"u@example.com"}],` +
		`"contexts":[{"context":{"session_id":"s1"},"trace_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}],` +
		`"events":[{"i":0,"c":0,"name":"llm.call","ts":"2026-03-20T12:00:00Z","event_id":"e1","payload":{"span_id":"0123456789abcdef","duration_ms":12.5}}]}` + "\n"
	path := t.TempDir() + "/telemetry.jsonl"
	if err := os.WriteFile(path, []byte(v4), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := expandTelemetry(path, &output); err != nil {
		t.Fatalf("expand v4 frame under FrameVersion %d: %v", telemetryformat.FrameVersion, err)
	}
	var event telemetryformat.Event
	if err := json.Unmarshal(bytes.TrimSpace(output.Bytes()), &event); err != nil {
		t.Fatal(err)
	}
	if event.SchemaVersion != 4 || event.Name != "llm.call" || event.User != "u@example.com" || event.TraceID == "" {
		t.Fatalf("expanded v4 event = %+v, want schema 4 with its name, user, and trace intact", event)
	}
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

func equalInts(got, want []int) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}
