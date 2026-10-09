package telemetry

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/metric"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"google.golang.org/grpc"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// defaultMetricsExportInterval is used when OtelMetricsConfig leaves
// ExportIntervalMs unset.
const defaultMetricsExportInterval = 60 * time.Second

// SystemMetricsSource returns the latest System Metrics sample, or nil
// before the first one.
type SystemMetricsSource func() *types.SystemMetricsSample

// MetricsExporter exports System Metrics as OTLP metrics. Every instrument
// is observable: it reads the sampler's latest sample at export time, so
// export never takes a sample of its own.
type MetricsExporter struct {
	provider *sdkmetric.MeterProvider
}

// NewSystemMetricsExporter builds the OTLP metrics export from the shared
// OTel config and its metrics block.
func NewSystemMetricsExporter(cfg types.OtelConfig, source SystemMetricsSource) (*MetricsExporter, error) {
	if cfg.Metrics == nil || !cfg.Metrics.Enabled {
		return nil, fmt.Errorf("otel metrics export is not enabled")
	}
	exporter, err := newOTLPMetricExporter(context.Background(), cfg)
	if err != nil {
		return nil, err
	}
	interval := defaultMetricsExportInterval
	if cfg.Metrics.ExportIntervalMs > 0 {
		interval = time.Duration(cfg.Metrics.ExportIntervalMs) * time.Millisecond
	}
	reader := sdkmetric.NewPeriodicReader(exporter, sdkmetric.WithInterval(interval))
	m, err := newMetricsExporterWithReader(cfg, reader, source)
	if err != nil {
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, "telemetry.otel_metrics", "otlp metrics export started", map[string]any{
		"endpoint": metricsEndpointForLog(cfg), "protocol": protocolOrDefault(cfg.Protocol),
		"interval_ms": interval.Milliseconds(), "temporality": temporalityName(cfg.Metrics.Temporality),
		"token_scope_set": metricsTokenScope(cfg) != "", "token_provider": tokenProviderForLog(cfg.TokenProvider),
	})
	return m, nil
}

// newMetricsExporterWithReader registers the System Metrics instruments on a
// meter provider backed by reader. Split out so tests can use a manual reader.
func newMetricsExporterWithReader(cfg types.OtelConfig, reader sdkmetric.Reader, source SystemMetricsSource) (*MetricsExporter, error) {
	serviceName := cfg.ServiceName
	if serviceName == "" {
		serviceName = "ion-engine"
	}
	provider := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(reader),
		sdkmetric.WithResource(otelResource(OtelConfig{ServiceName: serviceName, ResourceAttributes: cfg.ResourceAttributes})),
	)
	if err := registerSystemMetricsInstruments(provider.Meter("ion-engine/sysmetrics"), source); err != nil {
		_ = provider.Shutdown(context.Background()) //nolint:errcheck // abandoning a half-built provider
		return nil, err
	}
	return &MetricsExporter{provider: provider}, nil
}

// Shutdown flushes and stops the export.
func (m *MetricsExporter) Shutdown(ctx context.Context) error {
	if m == nil || m.provider == nil {
		return nil
	}
	return m.provider.Shutdown(ctx)
}

// registerSystemMetricsInstruments declares every exported instrument. The
// only attribute is `role`, a small fixed set: a per-process or per-name
// label would multiply the series a metrics store keeps.
func registerSystemMetricsInstruments(meter metric.Meter, source SystemMetricsSource) error {
	var samplesSeen atomic.Int64
	var lastSeen atomic.Int64

	hostCPU, err1 := meter.Float64ObservableGauge("ion.host.cpu.utilization", metric.WithUnit("1"),
		metric.WithDescription("Share of all host CPUs in use, 0..1"))
	memAvail, err2 := meter.Int64ObservableGauge("ion.host.memory.available", metric.WithUnit("By"),
		metric.WithDescription("Memory available to new work (container-aware)"))
	memLimit, err3 := meter.Int64ObservableGauge("ion.host.memory.limit", metric.WithUnit("By"),
		metric.WithDescription("Container memory limit, or physical memory when none applies"))
	diskFree, err4 := meter.Int64ObservableGauge("ion.host.disk.free", metric.WithUnit("By"),
		metric.WithDescription("Free space on the volume holding the engine's data"))
	procCPU, err5 := meter.Float64ObservableGauge("ion.process.cpu.utilization", metric.WithUnit("{cpu}"),
		metric.WithDescription("CPU cores in use by the engine's processes, by role"))
	procRSS, err6 := meter.Int64ObservableGauge("ion.process.memory.rss", metric.WithUnit("By"),
		metric.WithDescription("Resident memory of the engine's processes, by role"))
	heap, err7 := meter.Int64ObservableGauge("ion.engine.heap", metric.WithUnit("By"),
		metric.WithDescription("Engine Go heap in use"))
	goroutines, err8 := meter.Int64ObservableGauge("ion.engine.goroutines", metric.WithUnit("{goroutine}"))
	sessions, err9 := meter.Int64ObservableGauge("ion.engine.sessions", metric.WithUnit("{session}"))
	samples, err10 := meter.Int64ObservableCounter("ion.system_metrics.samples", metric.WithUnit("{sample}"),
		metric.WithDescription("System Metrics samples observed by the export"))
	gcPause, err11 := meter.Float64ObservableGauge("ion.engine.gc_pause.p99", metric.WithUnit("ms"),
		metric.WithDescription("p99 of the Go runtime's stop-the-world pauses in the last sample interval"))
	allocRate, err12 := meter.Float64ObservableGauge("ion.engine.alloc_rate", metric.WithUnit("By/s"),
		metric.WithDescription("Heap bytes the engine allocated per second in the last sample interval"))
	schedLatency, err13 := meter.Float64ObservableGauge("ion.engine.sched_latency.p99", metric.WithUnit("ms"),
		metric.WithDescription("p99 of goroutine scheduling latency in the last sample interval"))
	for _, err := range []error{err1, err2, err3, err4, err5, err6, err7, err8, err9, err10, err11, err12, err13} {
		if err != nil {
			return fmt.Errorf("register system metrics instrument: %w", err)
		}
	}

	_, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
		s := source()
		if s == nil {
			return nil
		}
		if s.SampledAt != lastSeen.Load() {
			lastSeen.Store(s.SampledAt)
			samplesSeen.Add(1)
		}
		o.ObserveInt64(samples, samplesSeen.Load())
		h := s.Host
		if h.CPUUtilization != nil {
			o.ObserveFloat64(hostCPU, *h.CPUUtilization)
		}
		o.ObserveInt64(memAvail, clampInt64(h.MemoryAvailableBytes))
		limit := h.MemoryLimitBytes
		if limit == 0 {
			limit = h.MemoryTotalBytes
		}
		o.ObserveInt64(memLimit, clampInt64(limit))
		o.ObserveInt64(diskFree, clampInt64(h.DiskFreeBytes))
		// The process gauges are summed per (role, session_id). session_id is
		// the only per-session label any gauge carries: sessions are few,
		// so the series count stays bounded, and it is what lets a
		// conversation's extension, MCP, and backend processes be charged
		// to it. Processes no session owns sum under an empty session_id.
		type roleSession struct{ role, session string }
		cpu := map[roleSession]float64{}
		rss := map[roleSession]uint64{}
		for _, p := range s.Processes {
			key := roleSession{role: p.Role, session: p.SessionID}
			if p.CPUPercent != nil {
				cpu[key] += *p.CPUPercent / 100
			}
			rss[key] += p.RSSBytes
		}
		for key, v := range rss {
			attrs := metric.WithAttributes(attribute.String("role", key.role), attribute.String("session_id", key.session))
			o.ObserveFloat64(procCPU, cpu[key], attrs)
			o.ObserveInt64(procRSS, clampInt64(v), attrs)
		}
		o.ObserveInt64(heap, clampInt64(s.Runtime.HeapBytes))
		o.ObserveInt64(goroutines, int64(s.Runtime.Goroutines))
		o.ObserveInt64(sessions, int64(s.Runtime.Sessions))
		o.ObserveFloat64(gcPause, s.Runtime.GCPauseP99Ms)
		o.ObserveFloat64(allocRate, s.Runtime.AllocRateBytesPerS)
		o.ObserveFloat64(schedLatency, s.Runtime.SchedLatencyP99Ms)
		return nil
	}, hostCPU, memAvail, memLimit, diskFree, procCPU, procRSS, heap, goroutines, sessions, samples, gcPause, allocRate, schedLatency)
	if err != nil {
		return fmt.Errorf("register system metrics callback: %w", err)
	}
	return nil
}

func clampInt64(v uint64) int64 {
	if v > 1<<63-1 {
		return 1<<63 - 1
	}
	return int64(v)
}

// temporalitySelector maps the config value to an SDK selector. "delta"
// selects delta for every instrument; anything else keeps the SDK default
// (cumulative).
func temporalitySelector(name string) sdkmetric.TemporalitySelector {
	if strings.EqualFold(name, "delta") {
		return func(sdkmetric.InstrumentKind) metricdata.Temporality { return metricdata.DeltaTemporality }
	}
	return sdkmetric.DefaultTemporalitySelector
}

func temporalityName(name string) string {
	if strings.EqualFold(name, "delta") {
		return "delta"
	}
	return "cumulative"
}

func protocolOrDefault(p string) string {
	if p == "" {
		return otlpProtocolHTTPProtobuf
	}
	return p
}

// metricsHTTPEndpoint resolves the HTTP metrics URL: the metrics block's own
// endpoint when set, otherwise the shared endpoint with the metrics path.
// A bare host gets /v1/metrics; a shared endpoint pointing at /v1/traces is
// moved to /v1/metrics; an explicit metrics endpoint with a path is used as
// given.
func metricsHTTPEndpoint(cfg types.OtelConfig) (string, bool, error) {
	raw, own := cfg.Endpoint, false
	if cfg.Metrics != nil && cfg.Metrics.Endpoint != "" {
		raw, own = cfg.Metrics.Endpoint, true
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", false, fmt.Errorf("invalid OTLP metrics endpoint %q", raw)
	}
	switch {
	case u.Path == "" || u.Path == "/":
		u.Path = "/v1/metrics"
	case !own && strings.HasSuffix(u.Path, "/v1/traces"):
		u.Path = strings.TrimSuffix(u.Path, "/v1/traces") + "/v1/metrics"
	case !own:
		u.Path = strings.TrimSuffix(u.Path, "/") + "/v1/metrics"
	}
	return u.String(), u.Scheme == "http", nil
}

func metricsEndpointForLog(cfg types.OtelConfig) string {
	if strings.EqualFold(cfg.Protocol, otlpProtocolGRPC) {
		if cfg.Metrics != nil && cfg.Metrics.Endpoint != "" {
			return cfg.Metrics.Endpoint
		}
		return cfg.Endpoint
	}
	if ep, _, err := metricsHTTPEndpoint(cfg); err == nil {
		return ep
	}
	return cfg.Endpoint
}

func newOTLPMetricExporter(ctx context.Context, cfg types.OtelConfig) (sdkmetric.Exporter, error) {
	scope := metricsTokenScope(cfg)
	auth := otlpTokenAuth{signal: "metrics", scope: scope, provider: cfg.TokenProvider}
	selector := temporalitySelector(cfg.Metrics.Temporality)
	switch protocolOrDefault(cfg.Protocol) {
	case otlpProtocolHTTPProtobuf:
		endpoint, insecure, err := metricsHTTPEndpoint(cfg)
		if err != nil {
			return nil, err
		}
		opts := []otlpmetrichttp.Option{
			otlpmetrichttp.WithEndpointURL(endpoint),
			otlpmetrichttp.WithHeaders(cfg.Headers),
			otlpmetrichttp.WithTemporalitySelector(selector),
		}
		if insecure {
			opts = append(opts, otlpmetrichttp.WithInsecure())
		}
		if scope != "" {
			opts = append(opts, otlpmetrichttp.WithHTTPClient(&http.Client{
				Transport: &tokenRoundTripper{auth: auth, next: http.DefaultTransport},
			}))
		}
		exp, err := otlpmetrichttp.New(ctx, opts...)
		if err != nil {
			return nil, fmt.Errorf("create OTLP HTTP metrics exporter: %w", err)
		}
		return exp, nil
	case otlpProtocolGRPC:
		raw := cfg.Endpoint
		if cfg.Metrics.Endpoint != "" {
			raw = cfg.Metrics.Endpoint
		}
		endpoint, insecure, err := grpcEndpoint(raw)
		if err != nil {
			return nil, err
		}
		opts := []otlpmetricgrpc.Option{
			otlpmetricgrpc.WithEndpoint(endpoint),
			otlpmetricgrpc.WithHeaders(cfg.Headers),
			otlpmetricgrpc.WithTemporalitySelector(selector),
		}
		if insecure {
			opts = append(opts, otlpmetricgrpc.WithInsecure())
		}
		if scope != "" {
			opts = append(opts, otlpmetricgrpc.WithDialOption(grpc.WithPerRPCCredentials(tokenRPCCredentials{auth: auth, secure: !insecure})))
		}
		exp, err := otlpmetricgrpc.New(ctx, opts...)
		if err != nil {
			return nil, fmt.Errorf("create OTLP gRPC metrics exporter: %w", err)
		}
		return exp, nil
	default:
		return nil, fmt.Errorf("unsupported OTLP protocol %q: use %q or %q", cfg.Protocol, otlpProtocolGRPC, otlpProtocolHTTPProtobuf)
	}
}
