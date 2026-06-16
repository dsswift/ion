package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestTaskComplete_EmitsRunCompleteTelemetry verifies that a TaskCompleteEvent
// flowing through handleNormalizedEvent emits a single run.complete telemetry
// event carrying the run-level fields (model, cost, duration, turns, token
// usage). This is the backend-agnostic funnel — every backend's
// TaskCompleteEvent passes through this path, so CliBackend (which emits no
// per-call spans) gets uniform run-level coverage here.
//
// Regression definition: with the run.complete emission removed, the collector
// buffers zero events and this test goes red.
func TestTaskComplete_EmitsRunCompleteTelemetry(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-telem", defaultConfig())

	// Wire a runID -> session key so handleNormalizedEvent resolves, and
	// attach an enabled collector with no flush targets so events stay in
	// the in-memory buffer for inspection.
	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	mgr.mu.Lock()
	s := mgr.sessions["tc-telem"]
	s.requestID = "run-tc-telem"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	// Drive a fully populated TaskCompleteEvent through the full path.
	mgr.handleNormalizedEvent("run-tc-telem", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.125,
			DurationMs: 4200,
			NumTurns:   3,
			Usage: types.UsageData{
				InputTokens:              intPtr(1000),
				OutputTokens:             intPtr(250),
				CacheReadInputTokens:     intPtr(800),
				CacheCreationInputTokens: intPtr(40),
			},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected exactly 1 %s event, got %d (all: %+v)", telemetry.RunComplete, len(runComplete), events)
	}

	p := runComplete[0].Payload
	assertPayloadStr(t, p, "model", "claude-sonnet-4-6")
	assertPayloadFloat(t, p, "costUsd", 0.125)
	assertPayloadInt64(t, p, "durationMs", 4200)
	assertPayloadInt(t, p, "numTurns", 3)
	assertPayloadInt(t, p, "inputTokens", 1000)
	assertPayloadInt(t, p, "outputTokens", 250)
	assertPayloadInt(t, p, "cacheReadInputTokens", 800)
	assertPayloadInt(t, p, "cacheCreationInputTokens", 40)
}

// TestTaskComplete_NoRunCompleteWhenTelemetryDisabled verifies the additive
// change stays silent when telemetry is turned off — a disabled collector
// buffers nothing even though the emission path runs.
func TestTaskComplete_NoRunCompleteWhenTelemetryDisabled(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-telem-off", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: false, Targets: []string{}})
	mgr.mu.Lock()
	s := mgr.sessions["tc-telem-off"]
	s.requestID = "run-tc-telem-off"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-tc-telem-off", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done", CostUsd: 0.1, NumTurns: 1},
	})

	events := drainTelemetry(t, collector)
	if len(events) != 0 {
		t.Fatalf("expected 0 buffered events with telemetry disabled, got %d: %+v", len(events), events)
	}
}

// TestTaskComplete_NoRunCompleteWhenNoCollector verifies the non-nil-collector
// guard: a session with no telemetry collector must not panic and must emit
// nothing. (This is the default for sessions started without a Telemetry
// config — s.telemetry stays nil.)
func TestTaskComplete_NoRunCompleteWhenNoCollector(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-telem-nil", defaultConfig())

	mgr.mu.Lock()
	s := mgr.sessions["tc-telem-nil"]
	s.requestID = "run-tc-telem-nil"
	// s.telemetry intentionally left nil.
	mgr.mu.Unlock()

	// Must not panic.
	mgr.handleNormalizedEvent("run-tc-telem-nil", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{Result: "done", CostUsd: 0.1, NumTurns: 1},
	})
}

// drainTelemetry reads the collector's in-memory buffer under its mutex,
// mirroring telemetry_test.go's buffer-inspection pattern.
func drainTelemetry(t *testing.T, c *telemetry.Collector) []telemetry.Event {
	t.Helper()
	return c.BufferedEvents()
}

func filterByName(events []telemetry.Event, name string) []telemetry.Event {
	var out []telemetry.Event
	for _, e := range events {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

func assertPayloadStr(t *testing.T, p map[string]any, key, want string) {
	t.Helper()
	got, ok := p[key].(string)
	if !ok || got != want {
		t.Errorf("payload[%q] = %v (%T), want %q", key, p[key], p[key], want)
	}
}

func assertPayloadFloat(t *testing.T, p map[string]any, key string, want float64) {
	t.Helper()
	got, ok := p[key].(float64)
	if !ok || got != want {
		t.Errorf("payload[%q] = %v (%T), want %v", key, p[key], p[key], want)
	}
}

func assertPayloadInt(t *testing.T, p map[string]any, key string, want int) {
	t.Helper()
	got, ok := p[key].(int)
	if !ok || got != want {
		t.Errorf("payload[%q] = %v (%T), want %d", key, p[key], p[key], want)
	}
}

func assertPayloadInt64(t *testing.T, p map[string]any, key string, want int64) {
	t.Helper()
	got, ok := p[key].(int64)
	if !ok || got != want {
		t.Errorf("payload[%q] = %v (%T), want %d", key, p[key], p[key], want)
	}
}
