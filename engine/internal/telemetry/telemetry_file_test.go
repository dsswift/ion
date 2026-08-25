package telemetry

import (
	"bufio"
	"os"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
)

// readTelemetryFile expands every physical telemetry frame in path. It accepts
// legacy event lines too, so checkpoint tests can seed older file versions.
func readTelemetryFile(path string) ([]Event, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer file.Close() //nolint:errcheck // read-only test helper

	var events []Event
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		lineEvents, err := telemetryformat.DecodeLine(scanner.Bytes())
		if err != nil {
			return nil, err
		}
		events = append(events, lineEvents...)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

func mustReadTelemetryFile(t interface {
	Helper()
	Fatalf(string, ...any)
}, path string) []Event {
	t.Helper()
	events, err := readTelemetryFile(path)
	if err != nil {
		t.Fatalf("read telemetry file %q: %v", path, err)
	}
	return events
}

func telemetryEventByName(events []Event, name string) (Event, bool) {
	for _, event := range events {
		if event.Name == name {
			return event, true
		}
	}
	return Event{}, false
}
