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

	data, err := os.ReadFile(fp)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) != 2 {
		t.Errorf("expected 2 lines, got %d", len(lines))
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

	data, err := os.ReadFile(fp)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if len(lines) < 2 {
		t.Errorf("expected at least 2 lines after batch flush, got %d", len(lines))
	}
}

// --- New tests ported from TS ---

func TestNewOtelBridge_Defaults(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint: "http://localhost:4318",
	})
	defer bridge.Close()

	if bridge.config.ServiceName != "ion-engine" {
		t.Errorf("ServiceName = %q, want ion-engine", bridge.config.ServiceName)
	}
	if bridge.config.BatchSize != 100 {
		t.Errorf("BatchSize = %d, want 100", bridge.config.BatchSize)
	}
	if bridge.config.FlushInterval != 10*time.Second {
		t.Errorf("FlushInterval = %v, want 10s", bridge.config.FlushInterval)
	}
}

func TestNewOtelBridge_CustomServiceName(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:    "http://localhost:4318",
		ServiceName: "my-custom-service",
	})
	defer bridge.Close()

	if bridge.config.ServiceName != "my-custom-service" {
		t.Errorf("ServiceName = %q, want my-custom-service", bridge.config.ServiceName)
	}
}

func TestOtelBridge_RecordEvent(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000, // Don't auto-flush.
	})
	defer bridge.Close()

	event := Event{
		Name:      "test.event",
		Timestamp: time.Now().UnixMilli(),
		Payload:   map[string]any{"key": "val"},
		Context:   map[string]any{"session": "s1"},
	}
	bridge.RecordEvent(event)

	bridge.mu.Lock()
	count := len(bridge.spans)
	bridge.mu.Unlock()

	if count != 1 {
		t.Fatalf("expected 1 span, got %d", count)
	}

	bridge.mu.Lock()
	span := bridge.spans[0]
	bridge.mu.Unlock()

	if span.Name != "test.event" {
		t.Errorf("span.Name = %q, want test.event", span.Name)
	}
	if span.Attributes["key"] != "val" {
		t.Errorf("expected attribute key=val")
	}
	if span.Attributes["ctx.session"] != "s1" {
		t.Errorf("expected context attribute ctx.session=s1")
	}
}

func TestOtelBridge_RecordEvent_ErrorStatus(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000,
	})
	defer bridge.Close()

	event := Event{
		Name:      ErrorEvent,
		Timestamp: time.Now().UnixMilli(),
		Payload:   map[string]any{"error": "something broke"},
	}
	bridge.RecordEvent(event)

	bridge.mu.Lock()
	span := bridge.spans[0]
	bridge.mu.Unlock()

	if span.Status == nil {
		t.Fatal("expected status on error event")
	}
	if span.Status.Code != 2 {
		t.Errorf("status.Code = %d, want 2 (error)", span.Status.Code)
	}
	if span.Status.Message != "something broke" {
		t.Errorf("status.Message = %q, want 'something broke'", span.Status.Message)
	}
}

func TestOtelBridge_RecordSpan(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000,
	})
	defer bridge.Close()

	startMs := time.Now().Add(-100 * time.Millisecond).UnixMilli()
	endMs := time.Now().UnixMilli()

	bridge.RecordSpan("test.span", startMs, endMs, map[string]any{"tool": "bash"})

	bridge.mu.Lock()
	count := len(bridge.spans)
	span := bridge.spans[0]
	bridge.mu.Unlock()

	if count != 1 {
		t.Fatalf("expected 1 span, got %d", count)
	}
	if span.Name != "test.span" {
		t.Errorf("span.Name = %q", span.Name)
	}
	if span.StartTime != startMs*1_000_000 {
		t.Errorf("StartTime = %d, want %d", span.StartTime, startMs*1_000_000)
	}
	if span.EndTime != endMs*1_000_000 {
		t.Errorf("EndTime = %d, want %d", span.EndTime, endMs*1_000_000)
	}
	if span.Attributes["tool"] != "bash" {
		t.Errorf("expected attribute tool=bash")
	}
}

func TestOtelBridge_FlushEmpty(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000,
	})
	defer bridge.Close()

	// Flushing with no spans should be a no-op.
	if err := bridge.Flush(); err != nil {
		t.Errorf("Flush empty: %v", err)
	}
}

func TestOtelBridge_Close(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000,
	})

	// Close should not panic.
	err := bridge.Close()
	if err != nil {
		// Error is expected since localhost:4318 isn't running.
		// That's fine, we just verify Close doesn't panic.
		_ = err
	}
}

func TestGenTraceID(t *testing.T) {
	id1 := genTraceID()
	id2 := genTraceID()

	if len(id1) != 32 {
		t.Errorf("traceID length = %d, want 32 hex chars", len(id1))
	}
	if id1 == id2 {
		t.Error("two trace IDs should be different")
	}
}

func TestGenSpanID(t *testing.T) {
	id1 := genSpanID()
	id2 := genSpanID()

	if len(id1) != 16 {
		t.Errorf("spanID length = %d, want 16 hex chars", len(id1))
	}
	if id1 == id2 {
		t.Error("two span IDs should be different")
	}
}

func TestOtelBridge_OTLPFormat(t *testing.T) {
	// Use a test HTTP server to capture the OTLP payload.
	var received []byte
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bridge := NewOtelBridge(OtelConfig{
		Endpoint:    server.URL,
		ServiceName: "test-svc",
		BatchSize:   1000,
	})
	defer bridge.Close()

	bridge.RecordEvent(Event{
		Name:      SessionStart,
		Timestamp: time.Now().UnixMilli(),
		Payload:   map[string]any{"sessionId": "s1"},
	})

	if err := bridge.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	if len(received) == 0 {
		t.Fatal("expected OTLP payload to be sent")
	}

	var payload otlpExportRequest
	if err := json.Unmarshal(received, &payload); err != nil {
		t.Fatalf("unmarshal OTLP payload: %v", err)
	}

	if len(payload.ResourceSpans) != 1 {
		t.Fatalf("expected 1 resourceSpan, got %d", len(payload.ResourceSpans))
	}
	rs := payload.ResourceSpans[0]
	if len(rs.Resource.Attributes) == 0 {
		t.Fatal("expected resource attributes")
	}
	if rs.Resource.Attributes[0].Key != "service.name" {
		t.Errorf("expected service.name attribute, got %q", rs.Resource.Attributes[0].Key)
	}
	if rs.Resource.Attributes[0].Value.StringValue != "test-svc" {
		t.Errorf("service.name = %q, want test-svc", rs.Resource.Attributes[0].Value.StringValue)
	}
	if len(rs.ScopeSpans) != 1 || len(rs.ScopeSpans[0].Spans) != 1 {
		t.Fatal("expected 1 scope span with 1 span")
	}
	span := rs.ScopeSpans[0].Spans[0]
	if span.Name != SessionStart {
		t.Errorf("span.Name = %q, want %q", span.Name, SessionStart)
	}
}

func TestOtelBridge_CustomHeaders(t *testing.T) {
	var gotHeaders http.Header
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeaders = r.Header
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bridge := NewOtelBridge(OtelConfig{
		Endpoint: server.URL,
		Headers:  map[string]string{"X-Api-Key": "secret-123"},
	})
	defer bridge.Close()

	bridge.RecordEvent(Event{Name: "test", Timestamp: time.Now().UnixMilli()})
	bridge.Flush()

	if gotHeaders.Get("X-Api-Key") != "secret-123" {
		t.Errorf("expected X-Api-Key header, got %q", gotHeaders.Get("X-Api-Key"))
	}
}

func TestCollector_SetOtelBridge(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  "http://localhost:4318",
		BatchSize: 1000,
	})
	defer bridge.Close()

	c := NewCollector(types.TelemetryConfig{Enabled: true})
	c.SetOtelBridge(bridge)

	c.Event("bridge.test", map[string]any{"x": 1}, nil)

	// Verify the event was forwarded to the bridge.
	bridge.mu.Lock()
	count := len(bridge.spans)
	bridge.mu.Unlock()

	if count != 1 {
		t.Errorf("expected 1 span in bridge, got %d", count)
	}
}

func TestOtelBridge_BatchFlush(t *testing.T) {
	flushCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		flushCount++
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bridge := NewOtelBridge(OtelConfig{
		Endpoint:  server.URL,
		BatchSize: 3,
	})
	defer bridge.Close()

	// Record 3 events -- should trigger auto-flush at batch size.
	for i := 0; i < 3; i++ {
		bridge.RecordEvent(Event{Name: "e", Timestamp: time.Now().UnixMilli()})
	}

	// Give a moment for the flush to complete.
	time.Sleep(50 * time.Millisecond)

	if flushCount < 1 {
		t.Errorf("expected at least 1 flush from batch, got %d", flushCount)
	}
}

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
	if _, ok := event.Payload["durationMs"]; !ok {
		t.Error("expected durationMs in payload")
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

	dur, ok := event.Payload["durationMs"].(int64)
	if !ok {
		t.Fatalf("durationMs not int64: %T", event.Payload["durationMs"])
	}
	if dur < 0 {
		t.Errorf("durationMs should be >= 0, got %d", dur)
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
