package telemetry

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	traceSDK "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	otlpProtocolHTTPProtobuf = "http/protobuf"
	otlpProtocolGRPC         = "grpc"
)

// OtelConfig configures the OpenTelemetry bridge.
type OtelConfig struct {
	Endpoint           string            `json:"endpoint"`
	Protocol           string            `json:"protocol"`
	Headers            map[string]string `json:"headers"`
	ServiceName        string            `json:"service_name"`
	ResourceAttributes map[string]string `json:"resource_attributes"`
	BatchSize          int               `json:"batch_size"`
	FlushInterval      time.Duration     `json:"flush_interval"`
}

// OtelBridge converts Ion events to OTLP spans and exports them through the
// OpenTelemetry SDK. NewOtelBridge preserves the established bridge API while
// the SDK owns OTLP protobuf encoding and transport-specific batching.
type OtelBridge struct {
	config         OtelConfig
	provider       *traceSDK.TracerProvider
	initErr        error
	flushDone      chan struct{}
	closeOnce      sync.Once
	flushCloseOnce sync.Once
}

// NewOtelBridge creates a bridge with an OTLP gRPC or HTTP/protobuf exporter.
// Invalid configuration is retained as a Flush error because this established
// constructor cannot return an error.
func NewOtelBridge(config OtelConfig) *OtelBridge {
	if config.ServiceName == "" {
		config.ServiceName = "ion-engine"
	}
	if config.Protocol == "" {
		config.Protocol = otlpProtocolHTTPProtobuf
	}
	if config.BatchSize <= 0 {
		config.BatchSize = 100
	}
	if config.FlushInterval <= 0 {
		config.FlushInterval = 10 * time.Second
	}

	bridge := &OtelBridge{
		config:    config,
		flushDone: make(chan struct{}),
	}

	exporter, err := newOTLPExporter(context.Background(), config)
	if err != nil {
		bridge.initErr = err
		return bridge
	}

	bridge.provider = traceSDK.NewTracerProvider(
		traceSDK.WithResource(otelResource(config)),
		traceSDK.WithBatcher(
			exporter,
			traceSDK.WithMaxExportBatchSize(config.BatchSize),
			traceSDK.WithBatchTimeout(config.FlushInterval),
		),
	)
	return bridge
}

func newOTLPExporter(ctx context.Context, config OtelConfig) (*otlptrace.Exporter, error) {
	switch config.Protocol {
	case otlpProtocolHTTPProtobuf:
		endpoint, insecure, err := httpTracesEndpoint(config.Endpoint)
		if err != nil {
			return nil, err
		}
		opts := []otlptracehttp.Option{
			otlptracehttp.WithEndpointURL(endpoint),
			otlptracehttp.WithHeaders(config.Headers),
		}
		if insecure {
			opts = append(opts, otlptracehttp.WithInsecure())
		}
		exporter, err := otlptracehttp.New(ctx, opts...)
		if err != nil {
			return nil, fmt.Errorf("create OTLP HTTP/protobuf exporter: %w", err)
		}
		return exporter, nil
	case otlpProtocolGRPC:
		endpoint, insecure, err := grpcEndpoint(config.Endpoint)
		if err != nil {
			return nil, err
		}
		opts := []otlptracegrpc.Option{
			otlptracegrpc.WithEndpoint(endpoint),
			otlptracegrpc.WithHeaders(config.Headers),
		}
		if insecure {
			opts = append(opts, otlptracegrpc.WithInsecure())
		}
		exporter, err := otlptracegrpc.New(ctx, opts...)
		if err != nil {
			return nil, fmt.Errorf("create OTLP gRPC exporter: %w", err)
		}
		return exporter, nil
	default:
		return nil, fmt.Errorf("unsupported OTLP protocol %q: use %q or %q", config.Protocol, otlpProtocolGRPC, otlpProtocolHTTPProtobuf)
	}
}

func httpTracesEndpoint(rawEndpoint string) (string, bool, error) {
	endpoint, err := url.Parse(rawEndpoint)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		return "", false, fmt.Errorf("invalid OTLP HTTP/protobuf endpoint %q", rawEndpoint)
	}
	if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
		return "", false, fmt.Errorf("invalid OTLP HTTP/protobuf endpoint scheme %q", endpoint.Scheme)
	}
	if endpoint.Path == "" || endpoint.Path == "/" {
		endpoint.Path = "/v1/traces"
	}
	return endpoint.String(), endpoint.Scheme == "http", nil
}

func grpcEndpoint(rawEndpoint string) (string, bool, error) {
	if !strings.Contains(rawEndpoint, "://") {
		if rawEndpoint == "" || strings.Contains(rawEndpoint, "/") {
			return "", false, fmt.Errorf("invalid OTLP gRPC endpoint %q", rawEndpoint)
		}
		return rawEndpoint, true, nil
	}

	endpoint, err := url.Parse(rawEndpoint)
	if err != nil || endpoint.Host == "" || endpoint.Path != "" && endpoint.Path != "/" {
		return "", false, fmt.Errorf("invalid OTLP gRPC endpoint %q", rawEndpoint)
	}
	if endpoint.Scheme != "http" && endpoint.Scheme != "https" {
		return "", false, fmt.Errorf("invalid OTLP gRPC endpoint scheme %q", endpoint.Scheme)
	}
	return endpoint.Host, endpoint.Scheme == "http", nil
}

func otelResource(config OtelConfig) *resource.Resource {
	attrs := make([]attribute.KeyValue, 0, len(config.ResourceAttributes)+1)
	for key, value := range config.ResourceAttributes {
		attrs = append(attrs, attribute.String(key, value))
	}
	attrs = append(attrs, attribute.String("service.name", config.ServiceName))
	return resource.NewWithAttributes("", attrs...)
}

// RecordEvent converts an Ion telemetry Event to an OTLP span.
func (b *OtelBridge) RecordEvent(event Event) {
	timestamp := eventTime(event.Ts)
	attrs := make(map[string]any, len(event.Payload)+len(event.Context))
	for key, value := range event.Payload {
		attrs[key] = value
	}
	for key, value := range event.Context {
		attrs["ctx."+key] = value
	}

	b.recordSpan(event.Name, timestamp, timestamp, attrs, event.TraceID, errorMessage(event.Payload))
}

// RecordSpan records a timed span directly. The attrs map becomes span
// attributes; ctx carries correlation separately, matching StartSpanCtx.
func (b *OtelBridge) RecordSpan(name string, startMs, endMs int64, attrs, ctx map[string]any) {
	b.recordSpan(
		name,
		time.UnixMilli(startMs),
		time.UnixMilli(endMs),
		attrs,
		traceIDFromCorrelationContext(ctx),
		"",
	)
}

func (b *OtelBridge) recordSpan(name string, start, end time.Time, attrs map[string]any, traceID, errMessage string) {
	if b.provider == nil {
		return
	}

	ctx := context.Background()
	if parent, ok := otelParentContext(traceID); ok {
		ctx = trace.ContextWithRemoteSpanContext(ctx, parent)
	}
	_, span := b.provider.Tracer("ion-engine").Start(ctx, name, trace.WithTimestamp(start))
	span.SetAttributes(otelAttributes(attrs)...)
	if errMessage != "" {
		span.SetStatus(codes.Error, errMessage)
	}
	span.End(trace.WithTimestamp(end))
}

func otelParentContext(traceID string) (trace.SpanContext, bool) {
	traceIDValue, err := trace.TraceIDFromHex(traceID)
	if err != nil || !traceIDValue.IsValid() {
		return trace.SpanContext{}, false
	}
	spanIDValue, err := trace.SpanIDFromHex(genSpanID())
	if err != nil {
		return trace.SpanContext{}, false
	}
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceIDValue,
		SpanID:     spanIDValue,
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	}), true
}

func otelAttributes(values map[string]any) []attribute.KeyValue {
	attrs := make([]attribute.KeyValue, 0, len(values))
	for key, value := range values {
		switch typed := value.(type) {
		case string:
			attrs = append(attrs, attribute.String(key, typed))
		case bool:
			attrs = append(attrs, attribute.Bool(key, typed))
		case int:
			attrs = append(attrs, attribute.Int(key, typed))
		case int64:
			attrs = append(attrs, attribute.Int64(key, typed))
		case float64:
			attrs = append(attrs, attribute.Float64(key, typed))
		case []string:
			attrs = append(attrs, attribute.StringSlice(key, typed))
		default:
			attrs = append(attrs, attribute.String(key, fmt.Sprint(typed)))
		}
	}
	return attrs
}

func eventTime(raw string) time.Time {
	if timestamp, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return timestamp
	}
	return time.Now()
}

func errorMessage(payload map[string]any) string {
	if errMessage, ok := payload["error"].(string); ok {
		return errMessage
	}
	return ""
}

// Flush exports all buffered OTLP spans.
func (b *OtelBridge) Flush() error {
	if b.initErr != nil {
		return b.initErr
	}
	if b.provider == nil {
		return nil
	}
	if err := b.provider.ForceFlush(context.Background()); err != nil {
		return fmt.Errorf("flush OTLP spans: %w", err)
	}
	return nil
}

// Close stops the bridge and exports any remaining spans. It is safe to call
// multiple times.
func (b *OtelBridge) Close() error {
	var closeErr error
	b.closeOnce.Do(func() {
		if b.provider != nil {
			if err := b.provider.Shutdown(context.Background()); err != nil {
				closeErr = fmt.Errorf("shutdown OTLP bridge: %w", err)
			}
		}
		b.flushCloseOnce.Do(func() { close(b.flushDone) })
	})
	return closeErr
}

// genSpanID generates an 8-byte random hex span ID.
func genSpanID() string {
	return utils.RandomID()
}
