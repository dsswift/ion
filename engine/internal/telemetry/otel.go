package telemetry

import (
	"bytes"
	"context"
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
	Key   string        `json:"key"`
	Value otlpAttrValue `json:"value"`
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
		config: config,
		spans:  make([]otlpSpan, 0, config.BatchSize),
		client: &http.Client{Timeout: 10 * time.Second},
		done:   make(chan struct{}),
	}

	go b.flushLoop()
	return b
}

// resolveTraceID picks the trace ID for a span. Precedence:
//  1. an explicit trace ID stamped on the event/caller (eventTraceID) — the
//     normal path, since the session layer mints a trace ID per run and stamps
//     it on every event emitted during that run,
//  2. a freshly generated trace ID for an event that carries none (an emission
//     with no run in flight).
//
// A per-session trace-ID registry used to sit between these two. It was
// removed with the move to run-scoped tracing: nothing ever populated it (its
// only setter had no caller in the tree), and reconstructing one trace per
// session is the exact behaviour run scoping replaced.
func (b *OtelBridge) resolveTraceID(eventTraceID string) string {
	if eventTraceID != "" {
		return eventTraceID
	}
	return genTraceID()
}

func (b *OtelBridge) flushLoop() {
	ticker := time.NewTicker(b.config.FlushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			b.Flush() //nolint:errcheck // best-effort flush on teardown
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

	// Prefer the trace ID the emitter stamped on the event. The session layer
	// mints one per run and stamps every event emitted during that run, so
	// spans belonging to one run share a trace without the bridge tracking
	// anything itself.
	span := otlpSpan{
		TraceID:    b.resolveTraceID(event.TraceID),
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
		b.Flush() //nolint:errcheck // best-effort flush on teardown
	}
}

// RecordSpan records a timed span directly. The attrs map becomes span
// attributes; ctx carries correlation separately, matching StartSpanCtx. When
// ctx carries a valid run trace_id the span joins that trace, otherwise it gets
// its own independent trace.
func (b *OtelBridge) RecordSpan(name string, startMs, endMs int64, attrs, ctx map[string]any) {
	eventTraceID := traceIDFromCorrelationContext(ctx)
	span := otlpSpan{
		TraceID:    b.resolveTraceID(eventTraceID),
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
		b.Flush() //nolint:errcheck // best-effort flush on teardown
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

// genTraceID generates a 16-byte W3C trace-context compliant trace ID.
// Delegates to utils.NewTraceID so the crypto/rand failure path produces a
// spec-valid non-zero value (W3C §3.2.2.3 requires consumers to reject an
// all-zero trace-id) and logs the entropy failure, rather than silently
// discarding the error and emitting zeros.
func genTraceID() string {
	return utils.NewTraceID()
}

// genSpanID generates an 8-byte random hex span ID. Delegates to
// utils.RandomID for the same reason genTraceID delegates: an all-zero
// span-id is invalid under W3C §3.2.2.4, and a discarded rand error is a
// silent failure.
func genSpanID() string {
	return utils.RandomID()
}
