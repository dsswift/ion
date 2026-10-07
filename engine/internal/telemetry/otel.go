package telemetry

import (
	"context"
	"fmt"
	"net/http"
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
	"google.golang.org/grpc"
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
	// TokenScope, when set, mints a bearer token for every trace export from
	// the credential TokenProvider names ("" = the identity provider).
	TokenScope    string `json:"token_scope"`
	TokenProvider string `json:"token_provider"`
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
		utils.LogWithFields(utils.LevelError, "telemetry.otel", "otlp trace export failed to start", map[string]any{
			"endpoint": config.Endpoint, "protocol": config.Protocol, "error": err.Error(),
		})
		return bridge
	}
	utils.LogWithFields(utils.LevelInfo, "telemetry.otel", "otlp trace export started", map[string]any{
		"endpoint": config.Endpoint, "protocol": config.Protocol,
		"token_scope_set": config.TokenScope != "", "token_provider": tokenProviderForLog(config.TokenProvider),
	})

	bridge.provider = traceSDK.NewTracerProvider(
		traceSDK.WithResource(otelResource(config)),
		traceSDK.WithIDGenerator(ionIDGenerator{}),
		traceSDK.WithBatcher(
			exporter,
			traceSDK.WithMaxExportBatchSize(config.BatchSize),
			traceSDK.WithBatchTimeout(config.FlushInterval),
		),
	)
	return bridge
}

func newOTLPExporter(ctx context.Context, config OtelConfig) (*otlptrace.Exporter, error) {
	tokenAuth := otlpTokenAuth{signal: "traces", scope: config.TokenScope, provider: config.TokenProvider}
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
		if config.TokenScope != "" {
			opts = append(opts, otlptracehttp.WithHTTPClient(&http.Client{
				Transport: &tokenRoundTripper{auth: tokenAuth, next: http.DefaultTransport},
			}))
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
		if config.TokenScope != "" {
			opts = append(opts, otlptracegrpc.WithDialOption(grpc.WithPerRPCCredentials(tokenRPCCredentials{auth: tokenAuth, secure: !insecure})))
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

// otelResource is the resource the SDK exports carry: the same identity log
// egress gives the engine's records (service.namespace, service.instance.id,
// host.name, service.version), under config.ServiceName. Configured resource
// attributes win over the derived ones; service.name is always ServiceName.
func otelResource(config OtelConfig) *resource.Resource {
	values := hostResourceAttributes(config.ResourceAttributes)
	values["service.name"] = config.ServiceName
	attrs := make([]attribute.KeyValue, 0, len(values))
	for key, value := range values {
		attrs = append(attrs, attribute.String(key, value))
	}
	return resource.NewWithAttributes("", attrs...)
}

// RecordEvent converts an Ion telemetry Event to an OTLP span. A span event
// (payload span_id + duration_ms, see span_handle.go) becomes a timed span
// under its own span-id, ending at ts. Any other event becomes a zero-length
// span. Either one is parented to the event's ParentSpanID when present.
func (b *OtelBridge) RecordEvent(event Event) {
	end := eventTime(event.Ts)
	start := end
	spanID := ""
	if id, durationMs, ok := spanIdentity(event.Payload); ok {
		spanID = id
		start = end.Add(-time.Duration(durationMs * float64(time.Millisecond)))
	}
	// The span's own id and its parent are the span's SpanId and
	// ParentSpanId, so neither is repeated as an attribute.
	attrs := make(map[string]any, len(event.Payload)+len(event.Context))
	for key, value := range event.Payload {
		switch key {
		case spanKindKey:
			attrs[spanKindAttr] = value
		case spanIDKey:
		default:
			attrs[key] = value
		}
	}
	for key, value := range event.Context {
		if key != parentSpanIDKey {
			attrs["ctx."+key] = value
		}
	}
	// The acting identity rides on every span so span metrics slice by
	// user. It is the event's resolved User (identityForEvent), the same
	// value the compact frame interns per identity.
	if event.User != "" {
		attrs["user"] = event.User
	}

	b.recordSpan(event.Name, start, end, attrs, spanIdentifiers{
		traceID:      event.TraceID,
		spanID:       spanID,
		parentSpanID: event.ParentSpanID,
	}, errorMessage(event.Payload))
}

// spanIdentity reports whether payload marks its event as a span, returning
// the span-id and duration.
func spanIdentity(payload map[string]any) (string, float64, bool) {
	id, _ := payload[spanIDKey].(string) //nolint:errcheck // non-string span_id is not a span
	if !utils.IsValidSpanID(id) {
		return "", 0, false
	}
	switch d := payload["duration_ms"].(type) {
	case float64:
		return id, d, true
	case int64:
		return id, float64(d), true
	case int:
		return id, float64(d), true
	}
	return "", 0, false
}

// spanIdentifiers are the W3C ids one exported span records under. Empty
// spanID mints one; empty or invalid parentSpanID makes the span a root of
// traceID; invalid traceID starts a fresh trace.
type spanIdentifiers struct {
	traceID      string
	spanID       string
	parentSpanID string
}

func (b *OtelBridge) recordSpan(name string, start, end time.Time, attrs map[string]any, ids spanIdentifiers, errMessage string) {
	if b.provider == nil {
		return
	}

	ctx := context.Background()
	traceID, traceErr := trace.TraceIDFromHex(ids.traceID)
	if traceErr == nil && traceID.IsValid() {
		if parentID, err := trace.SpanIDFromHex(ids.parentSpanID); err == nil && parentID.IsValid() {
			ctx = trace.ContextWithRemoteSpanContext(ctx, trace.NewSpanContext(trace.SpanContextConfig{
				TraceID:    traceID,
				SpanID:     parentID,
				TraceFlags: trace.FlagsSampled,
				Remote:     true,
			}))
		} else {
			ctx = context.WithValue(ctx, traceIDOverrideKey{}, traceID)
		}
	}
	if spanID, err := trace.SpanIDFromHex(ids.spanID); err == nil && spanID.IsValid() {
		ctx = context.WithValue(ctx, spanIDOverrideKey{}, spanID)
	}
	_, span := b.provider.Tracer("ion-engine").Start(ctx, name, trace.WithTimestamp(start), trace.WithSpanKind(spanKindFromAttrs(attrs)))
	span.SetAttributes(otelAttributes(attrs)...)
	if errMessage != "" {
		span.SetStatus(codes.Error, errMessage)
	}
	span.End(trace.WithTimestamp(end))
}

// spanKindFromAttrs reads the span kind recordSpan was handed. A span event
// names its kind in its payload's span_kind ("server" or "client"); anything
// else is internal.
func spanKindFromAttrs(attrs map[string]any) trace.SpanKind {
	switch attrs[spanKindAttr] {
	case SpanKindServer:
		return trace.SpanKindServer
	case SpanKindClient:
		return trace.SpanKindClient
	}
	return trace.SpanKindInternal
}

func otelAttributes(values map[string]any) []attribute.KeyValue {
	attrs := make([]attribute.KeyValue, 0, len(values))
	for key, value := range values {
		if key == spanKindAttr {
			continue
		}
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

type traceIDOverrideKey struct{}
type spanIDOverrideKey struct{}

// ionIDGenerator lets a span keep the ids Ion already assigned it, so the
// OTLP span and the JSONL telemetry event agree and children recorded
// elsewhere find their parent. Without an override it mints random ids.
type ionIDGenerator struct{}

func (ionIDGenerator) NewIDs(ctx context.Context) (trace.TraceID, trace.SpanID) {
	traceID, ok := ctx.Value(traceIDOverrideKey{}).(trace.TraceID)
	if !ok {
		//nolint:errcheck // NewTraceID always returns 32 hex characters
		traceID, _ = trace.TraceIDFromHex(utils.NewTraceID())
	}
	return traceID, ionIDGenerator{}.NewSpanID(ctx, traceID)
}

func (ionIDGenerator) NewSpanID(ctx context.Context, _ trace.TraceID) trace.SpanID {
	if spanID, ok := ctx.Value(spanIDOverrideKey{}).(trace.SpanID); ok {
		return spanID
	}
	//nolint:errcheck // NewSpanID always returns 16 hex characters
	spanID, _ := trace.SpanIDFromHex(utils.NewSpanID())
	return spanID
}
