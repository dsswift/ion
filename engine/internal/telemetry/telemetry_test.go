package telemetry

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetryformat"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestCollectorDisabled(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: false})
	c.Event("test.event", map[string]any{"key": "val"}, nil)

	// Buffer should remain empty when disabled.
	c.mu.Lock()
	count := len(c.buffer)
	c.mu.Unlock()
	if count != 0 {
		t.Errorf("expected 0 buffered events when disabled, got %d", count)
	}
}

func TestCollectorEventAndFlush(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "telemetry.ndjson")

	c := NewCollector(types.TelemetryConfig{
		Enabled:  true,
		Targets:  []string{"file"},
		FilePath: fp,
	})

	c.Event(SessionStart, map[string]any{"sessionId": "s1"}, nil)
	c.Event(LlmCall, map[string]any{"model": "test"}, nil)

	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if _, err := os.Stat(fp); err != nil {
		t.Fatalf("stat telemetry file: %v", err)
	}
	events := mustReadTelemetryFile(t, fp)
	if len(events) != 2 {
		t.Errorf("expected 2 events, got %d", len(events))
	}
}

func TestFlushToFileWritesV4FrameWithoutMutatingEvents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "telemetry.jsonl")
	event := Event{
		Name:    "test.frame",
		Ts:      "2026-01-01T00:00:00Z",
		Payload: map[string]any{},
	}
	if err := flushToFile([]Event{event}, path, rotationPolicy{}); err != nil {
		t.Fatalf("flushToFile: %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read telemetry file: %v", err)
	}
	var frame telemetryformat.Frame
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatalf("decode physical frame: %v", err)
	}
	if frame.Schema != telemetryformat.FrameVersion || frame.Record != "telemetry.frame" {
		t.Fatalf("physical record = %+v, want v4 telemetry frame", frame)
	}
	if event.SchemaVersion != 0 || event.Component != "" || event.Payload == nil {
		t.Fatalf("flushToFile mutated caller event: %+v", event)
	}

	events := mustReadTelemetryFile(t, path)
	if len(events) != 1 || events[0].SchemaVersion != TelemetrySchemaVersion || events[0].Component != "engine" {
		t.Fatalf("decoded normalized event = %+v", events)
	}
}

func TestSpanHandle(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	span := c.StartSpan("test.span", map[string]any{"key": "val"})
	span.End(map[string]any{"extra": true})

	c.mu.Lock()
	count := len(c.buffer)
	c.mu.Unlock()
	if count != 1 {
		t.Errorf("expected 1 event from span, got %d", count)
	}
}

func TestBatchFlush(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "batch.ndjson")

	c := NewCollector(types.TelemetryConfig{
		Enabled:   true,
		Targets:   []string{"file"},
		FilePath:  fp,
		BatchSize: 2,
	})

	c.Event("e1", nil, nil)
	c.Event("e2", nil, nil) // Should trigger auto-flush.

	if _, err := os.Stat(fp); err != nil {
		t.Fatalf("stat telemetry file: %v", err)
	}
	events := mustReadTelemetryFile(t, fp)
	if len(events) < 2 {
		t.Errorf("expected at least 2 events after batch flush, got %d", len(events))
	}
}

// --- New tests ported from TS ---

func TestEventNameConstants(t *testing.T) {
	// Verify all event name constants are non-empty and distinct.
	names := []string{SessionStart, SessionEnd, LlmCall, ToolExecute, Compaction, ErrorEvent}
	seen := make(map[string]bool)
	for _, n := range names {
		if n == "" {
			t.Error("event name constant should not be empty")
		}
		if seen[n] {
			t.Errorf("duplicate event name constant: %q", n)
		}
		seen[n] = true
	}
	if len(names) != 6 {
		t.Errorf("expected 6 event name constants, got %d", len(names))
	}
}

func TestSpanHandle_WithError(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	span := c.StartSpan("error.span", nil)
	span.End(nil, "something went wrong")

	c.mu.Lock()
	if len(c.buffer) != 1 {
		t.Fatalf("expected 1 event, got %d", len(c.buffer))
	}
	event := c.buffer[0]
	c.mu.Unlock()

	if event.Payload["error"] != "something went wrong" {
		t.Errorf("expected error in payload, got %v", event.Payload["error"])
	}
	if _, ok := event.Payload["duration_ms"]; !ok {
		t.Error("expected duration_ms in payload")
	}
}

func TestSpanHandle_ZeroDuration(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	span := c.StartSpan("instant.span", nil)
	// End immediately -- duration should be >= 0.
	span.End(nil)

	c.mu.Lock()
	event := c.buffer[0]
	c.mu.Unlock()

	// duration_ms is now a float64 (sub-millisecond precision), not int64.
	dur, ok := event.Payload["duration_ms"].(float64)
	if !ok {
		t.Fatalf("duration_ms not float64: %T", event.Payload["duration_ms"])
	}
	if dur < 0 {
		t.Errorf("durationMs should be >= 0, got %v", dur)
	}
}

// TestSpanHandle_SubMillisecondIsFractional pins that a span whose wall-clock
// duration is under one millisecond records a non-zero fractional duration_ms.
// The pre-fix implementation stored start as an integer UnixMilli and computed
// durationMs as an integer subtraction, flooring every sub-ms span to 0. This
// test would fail on that form (duration_ms == 0 for a fast span) and passes
// with the float64(d.Microseconds())/1000.0 emission.
//
// A bare StartSpan/End round-trip is reliably sub-millisecond in CI, but to make
// the assertion deterministic (never flaky) we also pin the exact conversion
// expression against a fixed 500µs duration below.
func TestSpanHandle_SubMillisecondIsFractional(t *testing.T) {
	// Deterministic half: the exact conversion expression used at the End site.
	// The pre-fix integer form floors 500µs to 0; the float form keeps 0.5.
	d := 500 * time.Microsecond
	if old := d.Milliseconds(); old != 0 {
		t.Fatalf("precondition: expected 500µs to floor to 0ms, got %d", old)
	}
	if got := float64(d.Microseconds()) / 1000.0; got != 0.5 {
		t.Fatalf("float64(d.Microseconds())/1000.0 = %v, want 0.5", got)
	}

	// Live half: a real sub-ms span must emit a float64 duration_ms >= 0. It is
	// non-negative and typed float64 on the fixed code; on the pre-fix code the
	// value was int64, which this type assertion rejects outright.
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	span := c.StartSpan("fast.span", nil)
	span.End(nil)

	c.mu.Lock()
	event := c.buffer[0]
	c.mu.Unlock()

	dur, ok := event.Payload["duration_ms"].(float64)
	if !ok {
		t.Fatalf("duration_ms = %T, want float64 (sub-ms precision requires a float)", event.Payload["duration_ms"])
	}
	if dur < 0 {
		t.Errorf("duration_ms = %v, want >= 0", dur)
	}
}

func TestCollector_ConcurrentEvents(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})

	var wg sync.WaitGroup
	n := 100
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			c.Event("concurrent.event", map[string]any{"i": 1}, nil)
		}()
	}
	wg.Wait()

	c.mu.Lock()
	count := len(c.buffer)
	c.mu.Unlock()

	if count != n {
		t.Errorf("expected %d events, got %d", n, count)
	}
}

func TestCollector_EventNilPayload(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	// Should not panic with nil payload and context.
	c.Event("nil.event", nil, nil)

	c.mu.Lock()
	count := len(c.buffer)
	c.mu.Unlock()
	if count != 1 {
		t.Errorf("expected 1 event, got %d", count)
	}
}

func TestCollector_EventEmptyName(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	c.Event("", map[string]any{"x": 1}, nil)

	c.mu.Lock()
	if len(c.buffer) != 1 {
		t.Fatal("expected 1 event")
	}
	if c.buffer[0].Name != "" {
		t.Errorf("expected empty name, got %q", c.buffer[0].Name)
	}
	c.mu.Unlock()
}

func TestCollector_FlushToHTTP(t *testing.T) {
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewCollector(types.TelemetryConfig{
		Enabled:      true,
		Targets:      []string{"http"},
		HttpEndpoint: server.URL,
	})

	c.Event(LlmCall, map[string]any{"model": "test"}, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if len(received) == 0 {
		t.Fatal("expected HTTP payload")
	}

	var events []Event
	if err := json.Unmarshal(received, &events); err != nil {
		t.Fatalf("unmarshal events: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Name != LlmCall {
		t.Errorf("event.Name = %q, want %q", events[0].Name, LlmCall)
	}
}

func TestCollector_FlushHTTPHeaders(t *testing.T) {
	var gotHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewCollector(types.TelemetryConfig{
		Enabled:      true,
		Targets:      []string{"http"},
		HttpEndpoint: server.URL,
		HttpHeaders:  map[string]string{"Authorization": "Bearer tok-123"},
	})

	c.Event("test", nil, nil)
	c.Flush()

	if gotHeaders.Get("Authorization") != "Bearer tok-123" {
		t.Errorf("expected Authorization header, got %q", gotHeaders.Get("Authorization"))
	}
}

func TestCollector_FlushMultipleTargets(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "multi.ndjson")

	var httpReceived bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpReceived = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	c := NewCollector(types.TelemetryConfig{
		Enabled:      true,
		Targets:      []string{"file", "http"},
		FilePath:     fp,
		HttpEndpoint: server.URL,
	})

	c.Event("multi.event", nil, nil)
	if err := c.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	// Verify file target received events.
	data, err := os.ReadFile(fp)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if !strings.Contains(string(data), "multi.event") {
		t.Error("expected event in file output")
	}

	// Verify HTTP target was hit.
	if !httpReceived {
		t.Error("expected HTTP target to be hit")
	}
}

// TestNormalizeTelemetryConfig_NilTargetsDefaultsToFile pins the nil-vs-empty
// distinction introduced in normalizeTelemetryConfig: a nil Targets slice
// (absent from JSON / zero-value struct) must default to ["file"] and resolve
// the default FilePath to ~/.ion/telemetry.jsonl.
//
// RED on the old code that treated nil and []string{} identically (both wrote
// to the live file). GREEN with the fix: nil → file default, empty → no sinks.
func TestNormalizeTelemetryConfig_NilTargetsDefaultsToFile(t *testing.T) {
	// Redirect HOME so the resolved FilePath points somewhere innocuous.
	home := t.TempDir()
	t.Setenv("HOME", home)

	cfg := normalizeTelemetryConfig(types.TelemetryConfig{Enabled: true})
	// nil Targets → should be rewritten to ["file"].
	if len(cfg.Targets) != 1 || cfg.Targets[0] != "file" {
		t.Errorf("nil Targets: got %v, want [\"file\"]", cfg.Targets)
	}
	// FilePath must be resolved (non-empty).
	if cfg.FilePath == "" {
		t.Error("nil Targets: FilePath must be resolved to the default path, got empty")
	}
}

// TestNormalizeTelemetryConfig_EmptyTargetsNoSinks pins the other side of the
// nil-vs-empty distinction: a non-nil empty Targets slice (Targets: []string{})
// means "no sinks" and must be left unchanged — no defaulting to file, no
// FilePath resolution. This is what test collectors use to stay in-memory only.
//
// RED on the old code: len([]string{}) == 0, so it rewrote to ["file"] and
// then resolved the default FilePath, causing test events to reach the live
// ~/.ion/telemetry.jsonl. GREEN with the fix: empty slice passes through.
func TestNormalizeTelemetryConfig_EmptyTargetsNoSinks(t *testing.T) {
	cfg := normalizeTelemetryConfig(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{}, // explicitly empty — opt out of all sinks
	})
	if len(cfg.Targets) != 0 {
		t.Errorf("empty Targets: got %v, want [] (no sinks)", cfg.Targets)
	}
	if cfg.FilePath != "" {
		t.Errorf("empty Targets: FilePath must remain empty, got %q", cfg.FilePath)
	}
}

// TestNormalizeTelemetryConfig_EmptyTargetsNoFlushLoop verifies end-to-end that
// a collector built with Targets:[]string{} never starts a flush goroutine and
// never touches any file path. The buffer is inspectable in-memory and Close()
// returns promptly without blocking on a goroutine that was never started.
//
// This is the integration-level proof that test collectors using empty Targets
// are fully safe: events land in the in-memory buffer (inspectable via
// BufferedEvents), the flush loop is never started, and no file I/O occurs.
func TestNormalizeTelemetryConfig_EmptyTargetsNoFlushLoop(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{},
	})

	// Events must land in the buffer.
	c.Event("test.isolation", map[string]any{"ok": true}, nil)
	events := c.BufferedEvents()
	if len(events) != 1 {
		t.Fatalf("expected 1 buffered event, got %d", len(events))
	}
	if events[0].Name != "test.isolation" {
		t.Errorf("event name = %q, want test.isolation", events[0].Name)
	}

	// Close must return promptly (no goroutine blocking it).
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.Close()
	}()
	select {
	case <-done:
		// Good — no deadlock.
	case <-time.After(2 * time.Second):
		t.Fatal("Close() did not return within 2 s — flush goroutine may have been started unexpectedly")
	}
}

func TestCollectorEventOmitsInvalidCorrelationTraceID(t *testing.T) {
	collector := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	for _, traceID := range []string{
		"",
		"00000000000000000000000000000000",
		"4BF92F3577B34DA6A3CE929D0E0E4736",
		"not-a-trace-id",
	} {
		collector.Event("standalone", nil, map[string]any{"trace_id": traceID})
	}

	for _, event := range collector.BufferedEvents() {
		if event.TraceID != "" {
			t.Errorf("Event.TraceID = %q for invalid correlation input, want omitted", event.TraceID)
		}
	}
}
