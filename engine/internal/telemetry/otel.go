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
	TraceID    string         `json:"traceId"`
	SpanID     string         `json:"spanId"`
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
		config: config,
		spans:  make([]otlpSpan, 0, config.BatchSize),
		client: &http.Client{Timeout: 10 * time.Second},
		done:   make(chan struct{}),
	}

	go b.flushLoop()
	return b
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
	ts := event.Timestamp * 1_000_000 // ms -> ns
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

	span := otlpSpan{
		TraceID:    genTraceID(),
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

// RecordSpan records a timed span directly.
func (b *OtelBridge) RecordSpan(name string, startMs, endMs int64, attrs map[string]any) {
	span := otlpSpan{
		TraceID:    genTraceID(),
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
	resp.Body.Close()
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
