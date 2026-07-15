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
	assertPayloadFloat(t, p, "run_cost_usd", 0.125)
	assertPayloadInt64(t, p, "duration_ms", 4200)
	assertPayloadInt(t, p, "num_turns", 3)
	assertPayloadInt(t, p, "input_tokens", 1000)
	assertPayloadInt(t, p, "output_tokens", 250)
	assertPayloadInt(t, p, "cache_read_input_tokens", 800)
	assertPayloadInt(t, p, "cache_creation_input_tokens", 40)
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

func assertCtxStr(t *testing.T, ctx map[string]any, key, want string) {
	t.Helper()
	if ctx == nil {
		t.Errorf("event context is nil, want %q=%q", key, want)
		return
	}
	got, ok := ctx[key].(string)
	if !ok || got != want {
		t.Errorf("context[%q] = %v (%T), want %q", key, ctx[key], ctx[key], want)
	}
}

// TestTaskComplete_RunComplete_CorrelationCtx asserts that run.complete emits
// with a non-nil context carrying both session_id and conversation_id. This is
// the regression test for the nil-ctx defect: against the pre-fix code (which
// passed nil), this test fails because event.Context is nil and the
// assertCtxStr helper reports the nil.
func TestTaskComplete_RunComplete_CorrelationCtx(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-ctx", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantConvID = "conv-abc-123"
	mgr.mu.Lock()
	s := mgr.sessions["tc-ctx"]
	s.requestID = "run-tc-ctx"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	s.conversationID = wantConvID
	mgr.mu.Unlock()

	mgr.handleNormalizedEvent("run-tc-ctx", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.05,
			DurationMs: 1000,
			NumTurns:   1,
			Usage: types.UsageData{
				InputTokens:  intPtr(500),
				OutputTokens: intPtr(100),
			},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected 1 run.complete event, got %d", len(runComplete))
	}
	e := runComplete[0]
	assertCtxStr(t, e.Context, "session_id", "tc-ctx")
	assertCtxStr(t, e.Context, "conversation_id", wantConvID)
}

// TestTaskComplete_RunComplete_AggregateCostAndDispatchDepth is the regression
// test for root cause 2 of the Cost dashboard gap: run.complete telemetry
// previously emitted only the per-run costUsd, excluding sub-agent spend.
//
// The fix adds aggregateCostUsd (this session + all descendant dispatches,
// computed via cost.ConversationCost) and dispatchDepth (always 0 at the
// manager-level emission point, which is the root-session path) to the
// run.complete payload alongside the existing costUsd.
//
// RED on unfixed code: the payload has no "aggregateCostUsd" key and no
// "dispatchDepth" key. GREEN with fix: both fields are present with the
// expected values.
func TestTaskComplete_RunComplete_AggregateCostAndDispatchDepth(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-agg", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	mgr.mu.Lock()
	s := mgr.sessions["tc-agg"]
	s.requestID = "run-tc-agg"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	// conversationID is intentionally empty so cost.ConversationCost returns 0
	// (no conv file to walk) — we still assert the field is present.
	mgr.mu.Unlock()

	// Drive a TaskCompleteEvent with both per-run and aggregate costs. Note:
	// TaskCompleteEvent has no AggregateCostUsd field — the engine computes it
	// at the emission site. With an empty conversationID the computed aggregate
	// is 0 (no conv file), so we assert the key is present with value 0.0.
	mgr.handleNormalizedEvent("run-tc-agg", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.1,
			DurationMs: 3000,
			NumTurns:   2,
			Usage: types.UsageData{
				InputTokens:  intPtr(500),
				OutputTokens: intPtr(100),
			},
		},
	})

	events := drainTelemetry(t, collector)
	runComplete := filterByName(events, telemetry.RunComplete)
	if len(runComplete) != 1 {
		t.Fatalf("expected exactly 1 %s event, got %d", telemetry.RunComplete, len(runComplete))
	}

	p := runComplete[0].Payload

	// run_cost_usd must still be the per-run value (not overwritten by aggregate).
	assertPayloadFloat(t, p, "run_cost_usd", 0.1)

	// aggregate_cost_usd must be present. With empty conversationID the walk
	// returns 0 — the key's presence is the contract, the value is 0.0.
	if _, ok := p["aggregate_cost_usd"]; !ok {
		t.Errorf("payload missing key %q (run.complete must carry aggregate_cost_usd)", "aggregate_cost_usd")
	}
	assertPayloadFloat(t, p, "aggregate_cost_usd", 0.0)

	// dispatch_depth must be present and 0 (manager-level emission = root run).
	if _, ok := p["dispatch_depth"]; !ok {
		t.Errorf("payload missing key %q (run.complete must carry dispatch_depth)", "dispatch_depth")
	}
	assertPayloadInt(t, p, "dispatch_depth", 0)
}

// with a non-nil context carrying both session_id and conversation_id. Against
// the pre-fix code (which passed only {"session_id": key} and omitted
// conversation_id), the conversation_id assertion fails.
func TestTaskComplete_CacheSavings_CorrelationCtx(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("tc-cache-ctx", defaultConfig())

	collector := telemetry.NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	const wantConvID = "conv-cache-456"
	mgr.mu.Lock()
	s := mgr.sessions["tc-cache-ctx"]
	s.requestID = "run-tc-cache-ctx"
	s.telemetry = collector
	s.lastModel = "claude-sonnet-4-6"
	s.conversationID = wantConvID
	mgr.mu.Unlock()

	// Drive a TaskCompleteEvent with cache tokens so cache.savings fires.
	mgr.handleNormalizedEvent("run-tc-cache-ctx", types.NormalizedEvent{
		Data: &types.TaskCompleteEvent{
			Result:     "done",
			CostUsd:    0.10,
			DurationMs: 2000,
			NumTurns:   2,
			Usage: types.UsageData{
				InputTokens:              intPtr(1000),
				OutputTokens:             intPtr(200),
				CacheReadInputTokens:     intPtr(600),
				CacheCreationInputTokens: intPtr(50),
			},
		},
	})

	events := drainTelemetry(t, collector)
	cacheSavings := filterByName(events, telemetry.CacheSavings)
	if len(cacheSavings) != 1 {
		t.Fatalf("expected 1 cache.savings event, got %d (all events: %+v)", len(cacheSavings), events)
	}
	e := cacheSavings[0]
	assertCtxStr(t, e.Context, "session_id", "tc-cache-ctx")
	assertCtxStr(t, e.Context, "conversation_id", wantConvID)
}
