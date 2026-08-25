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
	if want := []int{3, 4, 4}; !equalInts(schemas, want) {
		t.Fatalf("schemas = %v, want %v", schemas, want)
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
