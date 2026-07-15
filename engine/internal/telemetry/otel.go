package telemetry

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// OtelConfig configures the OpenTelemetry bridge.
type OtelConfig struct {
	Endpoint      string            `json:"endpoint"`       // OTLP HTTP endpoint
	Headers       map[string]string `json:"headers"`        // Auth headers
	ServiceName   string            `json:"service_name"`   // Default: "ion-engine"
	BatchSize     int               `json:"batch_size"`     // Default: 100
	FlushInterval time.Duration     `json:"flush_interval"` // Default: 10s
}

// OtelBridge converts Ion events to OTLP and exports them.
type OtelBridge struct {
	config OtelConfig
	mu     sync.Mutex
	spans  []otlpSpan
	client *http.Client
	done   chan struct{}
	// traceIDs maps a session ID to its stable trace ID so that every span
	// emitted for one session shares a single trace ID. Populated via
	// SessionTraceID; consulted by RecordEvent/RecordSpan when an event does
	// not carry its own TraceID. Guarded by mu.
	traceIDs map[string]string
}

// otlpSpan is a simplified OTLP span for export.
type otlpSpan struct {
	TraceID    string         `json:"trace_id"`
	SpanID     string         `json:"span_id"`
	Name       string         `json:"name"`
	StartTime  int64          `json:"startTimeUnixNano"`
	EndTime    int64          `json:"endTimeUnixNano"`
	Attributes map[string]any `json:"attributes"`
	Status     *otlpStatus    `json:"status,omitempty"`
}

type otlpStatus struct {
	Code    int    `json:"code"` // 0=unset, 1=ok, 2=error
	Message string `json:"message,omitempty"`
}

// OTLP export envelope types (simplified).
type otlpExportRequest struct {
	ResourceSpans []otlpResourceSpan `json:"resourceSpans"`
}

type otlpResourceSpan struct {
	Resource   otlpResource    `json:"resource"`
	ScopeSpans []otlpScopeSpan `json:"scopeSpans"`
}

type otlpResource struct {
	Attributes []otlpAttribute `json:"attributes"`
}

type otlpScopeSpan struct {
	Scope otlpScope  `json:"scope"`
	Spans []otlpSpan `json:"spans"`
}

type otlpScope struct {
	Name string `json:"name"`
}

type otlpAttribute struct {
	Key   string         `json:"key"`
	Value otlpAttrValue  `json:"value"`
}

type otlpAttrValue struct {
	StringValue string `json:"stringValue,omitempty"`
}

// NewOtelBridge creates a bridge and starts the background flush goroutine.
func NewOtelBridge(config OtelConfig) *OtelBridge {
	if config.ServiceName == "" {
		config.ServiceName = "ion-engine"
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 100
	}
	if config.FlushInterval <= 0 {
		config.FlushInterval = 10 * time.Second
	}

	b := &OtelBridge{
		config:   config,
		spans:    make([]otlpSpan, 0, config.BatchSize),
		client:   &http.Client{Timeout: 10 * time.Second},
		done:     make(chan struct{}),
		traceIDs: make(map[string]string),
	}

	go b.flushLoop()
	return b
}

// SessionTraceID registers the trace ID for a session so that every span the
// bridge emits for that session shares one trace ID. Idempotent; a repeat call
// with the same session ID overwrites the mapping. Pass an empty traceID to
// forget the session (e.g. on session end).
func (b *OtelBridge) SessionTraceID(sessionID, traceID string) {
	if sessionID == "" {
		return
	}
	b.mu.Lock()
	if traceID == "" {
		delete(b.traceIDs, sessionID)
	} else {
		b.traceIDs[sessionID] = traceID
	}
	b.mu.Unlock()
}

// resolveTraceID picks the trace ID for a span. Precedence:
//  1. an explicit trace ID stamped on the event/caller (eventTraceID),
//  2. the session's registered trace ID (looked up via sessionID),
//  3. a freshly generated per-span trace ID (legacy fallback).
//
// This fixes the correlation defect where genTraceID() ran per event, giving
// every span in a session a different trace ID.
func (b *OtelBridge) resolveTraceID(eventTraceID, sessionID string) string {
	if eventTraceID != "" {
		return eventTraceID
	}
	if sessionID != "" {
		b.mu.Lock()
		id := b.traceIDs[sessionID]
		b.mu.Unlock()
		if id != "" {
			return id
		}
	}
	return genTraceID()
}

func (b *OtelBridge) flushLoop() {
	ticker := time.NewTicker(b.config.FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			_ = b.Flush()
		case <-b.done:
			return
		}
	}
}

// RecordEvent converts an Ion telemetry Event to an OTLP span and buffers it.
func (b *OtelBridge) RecordEvent(event Event) {
	// Parse the RFC3339Nano ts string to nanoseconds for the OTLP span.
	// Falls back to current time when the field is absent or unparseable.
	var tsNs int64
	if event.Ts != "" {
		if t, err := time.Parse(time.RFC3339Nano, event.Ts); err == nil {
			tsNs = t.UnixNano()
		}
	}
	if tsNs == 0 {
		tsNs = time.Now().UnixNano()
	}
	ts := tsNs
	attrs := make(map[string]any, len(event.Payload)+len(event.Context))
	for k, v := range event.Payload {
		attrs[k] = v
	}
	for k, v := range event.Context {
		attrs["ctx."+k] = v
	}

	var status *otlpStatus
	if errMsg, ok := event.Payload["error"].(string); ok && errMsg != "" {
		status = &otlpStatus{Code: 2, Message: errMsg}
	}

	// Session-aware trace ID so all spans in a session correlate. Prefer an
	// explicit TraceID on the event, then the session's registered trace ID
	// (via ctx.session_id), then a fresh fallback.
	sessionID, _ := event.Context["session_id"].(string)

	span := otlpSpan{
		TraceID:    b.resolveTraceID(event.TraceID, sessionID),
		SpanID:     genSpanID(),
		Name:       event.Name,
		StartTime:  ts,
		EndTime:    ts,
		Attributes: attrs,
		Status:     status,
	}

	b.mu.Lock()
	b.spans = append(b.spans, span)
	shouldFlush := len(b.spans) >= b.config.BatchSize
	b.mu.Unlock()

	if shouldFlush {
		_ = b.Flush()
	}
}

// RecordSpan records a timed span directly. When attrs carries "session_id"
// (or an explicit "trace_id"), the span is stamped with the session's stable
// trace ID so it correlates with the session's other spans.
func (b *OtelBridge) RecordSpan(name string, startMs, endMs int64, attrs map[string]any) {
	var eventTraceID, sessionID string
	if attrs != nil {
		eventTraceID, _ = attrs["trace_id"].(string)
		sessionID, _ = attrs["session_id"].(string)
	}
	span := otlpSpan{
		TraceID:    b.resolveTraceID(eventTraceID, sessionID),
		SpanID:     genSpanID(),
		Name:       name,
		StartTime:  startMs * 1_000_000,
		EndTime:    endMs * 1_000_000,
		Attributes: attrs,
	}

	b.mu.Lock()
	b.spans = append(b.spans, span)
	shouldFlush := len(b.spans) >= b.config.BatchSize
	b.mu.Unlock()

	if shouldFlush {
		_ = b.Flush()
	}
}

// Flush exports buffered spans to the OTLP endpoint via POST.
func (b *OtelBridge) Flush() error {
	b.mu.Lock()
	if len(b.spans) == 0 {
		b.mu.Unlock()
		return nil
	}
	spans := make([]otlpSpan, len(b.spans))
	copy(spans, b.spans)
	b.spans = b.spans[:0]
	b.mu.Unlock()

	payload := otlpExportRequest{
		ResourceSpans: []otlpResourceSpan{{
			Resource: otlpResource{
				Attributes: []otlpAttribute{{
					Key:   "service.name",
					Value: otlpAttrValue{StringValue: b.config.ServiceName},
				}},
			},
			ScopeSpans: []otlpScopeSpan{{
				Scope: otlpScope{Name: b.config.ServiceName},
				Spans: spans,
			}},
		}},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("otel marshal: %w", err)
	}

	endpoint := b.config.Endpoint + "/v1/traces"
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("otel request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range b.config.Headers {
		req.Header.Set(k, v)
	}

	resp, err := b.client.Do(req)
	if err != nil {
		return fmt.Errorf("otel export: %w", err)
	}
	if err := resp.Body.Close(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "telemetry.otel", "export response body close failed", map[string]any{"error": err.Error()})
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("otel export returned status %d", resp.StatusCode)
	}
	return nil
}

// Close flushes remaining spans and stops the background goroutine.
func (b *OtelBridge) Close() error {
	close(b.done)
	return b.Flush()
}

// genTraceID generates a 16-byte random hex trace ID.
func genTraceID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// genSpanID generates an 8-byte random hex span ID.
func genSpanID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
