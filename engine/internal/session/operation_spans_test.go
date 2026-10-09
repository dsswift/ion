package session

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	opSpanTraceID  = "4bf92f3577b34da6a3ce929d0e0e4736"
	opSpanDispatch = "00f067aa0ba902b7"
)

// newTelemetrySessionManager returns a manager whose sessions each get an
// enabled collector that buffers every event.
func newTelemetrySessionManager(t *testing.T) *Manager {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	mgr := NewManager(newMockBackend())
	mgr.SetConfig(&types.EngineRuntimeConfig{Telemetry: &types.TelemetryConfig{Enabled: true, Targets: []string{}}})
	return mgr
}

func sessionCollector(t *testing.T, mgr *Manager, key string) *telemetry.Collector {
	t.Helper()
	mgr.mu.RLock()
	defer mgr.mu.RUnlock()
	s, ok := mgr.sessions[key]
	if !ok || s.telemetry == nil {
		t.Fatalf("session %q has no collector", key)
	}
	return s.telemetry
}

func spansNamed(c *telemetry.Collector, name string) []telemetry.Event {
	var out []telemetry.Event
	for _, e := range c.BufferedEvents() {
		if e.Name == name {
			out = append(out, e)
		}
	}
	return out
}

// assertSpan fails unless e is a span (valid span_id, numeric duration_ms)
// in trace traceID under parent.
func assertSpan(t *testing.T, e telemetry.Event, traceID, parent string) {
	t.Helper()
	if id, _ := e.Payload["span_id"].(string); !utils.IsValidSpanID(id) { //nolint:errcheck // a missing id fails here
		t.Fatalf("%s span_id = %v", e.Name, e.Payload["span_id"])
	}
	if d, ok := e.Payload["duration_ms"].(float64); !ok || d < 0 {
		t.Fatalf("%s duration_ms = %v", e.Name, e.Payload["duration_ms"])
	}
	if e.TraceID != traceID || e.ParentSpanID != parent {
		t.Fatalf("%s trace/parent = %s/%s, want %s/%s", e.Name, e.TraceID, e.ParentSpanID, traceID, parent)
	}
}

// session.start joins the start_session command's trace under its
// command.dispatch span, and the conversation read during the start is its
// child.
func TestSessionStartSpanParentsConversationLoad(t *testing.T) {
	mgr := newTelemetrySessionManager(t)
	key := "span-start"
	traceparent := utils.FormatTraceparent(opSpanTraceID, opSpanDispatch)
	if _, err := mgr.StartSessionTraced(key, types.EngineConfig{ProfileID: "test"}, nil, traceparent); err != nil {
		t.Fatalf("StartSessionTraced: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	c := sessionCollector(t, mgr, key)

	starts := spansNamed(c, telemetry.SessionStart)
	if len(starts) != 1 {
		t.Fatalf("session.start events = %d, want 1", len(starts))
	}
	assertSpan(t, starts[0], opSpanTraceID, opSpanDispatch)
	if starts[0].Payload["existed"] != false {
		t.Fatalf("existed = %v, want false on a fresh start", starts[0].Payload["existed"])
	}
	startSpanID, _ := starts[0].Payload["span_id"].(string) //nolint:errcheck // checked by assertSpan

	loads := spansNamed(c, telemetry.ConversationLoad)
	if len(loads) != 1 {
		t.Fatalf("conversation.load events = %d, want 1", len(loads))
	}
	assertSpan(t, loads[0], opSpanTraceID, startSpanID)
	if loads[0].Payload["source"] != "rehydrate" {
		t.Fatalf("source = %v", loads[0].Payload["source"])
	}
	if _, has := loads[0].Payload["error"]; has {
		t.Fatalf("a first-run not-found load is not a span error: %v", loads[0].Payload["error"])
	}
}

// Without a traceparent, session.start is a trace root.
func TestSessionStartSpanWithoutTraceparentIsRoot(t *testing.T) {
	mgr := newTelemetrySessionManager(t)
	key := "span-start-root"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	starts := spansNamed(sessionCollector(t, mgr, key), telemetry.SessionStart)
	if len(starts) != 1 {
		t.Fatalf("session.start events = %d, want 1", len(starts))
	}
	if starts[0].ParentSpanID != "" || !utils.IsValidTraceID(starts[0].TraceID) {
		t.Fatalf("root session.start trace/parent = %s/%s", starts[0].TraceID, starts[0].ParentSpanID)
	}
}

// extension.spawn and mcp.start record under the session.start span while
// the session is starting.
func TestExtensionSpawnAndMcpStartSpansParentUnderSessionStart(t *testing.T) {
	mgr := newTelemetrySessionManager(t)
	key := "span-children"
	if _, err := mgr.StartSession(key, types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	t.Cleanup(func() { mgr.StopSession(key) }) //nolint:errcheck // best-effort test teardown
	mgr.mu.RLock()
	s := mgr.sessions[key]
	mgr.mu.RUnlock()

	const startSpan = "aaaabbbbccccdddd"
	mgr.startTraces.begin(key, sessionStartTrace{traceID: opSpanTraceID, spanID: startSpan})
	mgr.startExtensionSpawnSpan(s, key, "/x/ext/index.ts").end(nil, errors.New("init timed out"))
	mgr.startMcpStartSpan(s, key, "fs")(nil, nil)
	mgr.startTraces.end(key)

	c := sessionCollector(t, mgr, key)
	spawns := spansNamed(c, telemetry.ExtensionSpawn)
	if len(spawns) != 1 {
		t.Fatalf("extension.spawn events = %d, want 1", len(spawns))
	}
	assertSpan(t, spawns[0], opSpanTraceID, startSpan)
	if spawns[0].Payload["error"] != "init timed out" || spawns[0].Payload["transpiled_ts"] != true {
		t.Fatalf("extension.spawn payload = %v", spawns[0].Payload)
	}
	starts := spansNamed(c, telemetry.McpStart)
	if len(starts) != 1 {
		t.Fatalf("mcp.start events = %d, want 1", len(starts))
	}
	assertSpan(t, starts[0], opSpanTraceID, startSpan)
	if starts[0].Payload["server"] != "fs" {
		t.Fatalf("mcp.start payload = %v", starts[0].Payload)
	}
}
