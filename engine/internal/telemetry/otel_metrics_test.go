package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"

	"github.com/dsswift/ion/engine/internal/types"
)

func fixtureSample(at int64) *types.SystemMetricsSample {
	util := 0.4
	engineCPU, mcpCPU := 50.0, 25.0
	return &types.SystemMetricsSample{
		SampledAt: at,
		Host: types.SystemMetricsHost{
			CPUUtilization: &util, MemoryTotalBytes: 16 << 30, MemoryAvailableBytes: 8 << 30, DiskFreeBytes: 100 << 30,
		},
		Processes: []types.SystemMetricsProcess{
			{Role: "engine", CPUPercent: &engineCPU, RSSBytes: 200 << 20},
			{Role: "mcp", CPUPercent: &mcpCPU, RSSBytes: 30 << 20},
			{Role: "mcp", RSSBytes: 10 << 20},
		},
		Runtime: types.SystemMetricsRuntime{HeapBytes: 50 << 20, Goroutines: 42, Sessions: 3},
	}
}

func collect(t *testing.T, reader *sdkmetric.ManualReader) map[string]metricdata.Metrics {
	t.Helper()
	var rm metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &rm); err != nil {
		t.Fatal(err)
	}
	out := map[string]metricdata.Metrics{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			out[m.Name] = m
		}
	}
	return out
}

func TestSystemMetricsGaugesCarryNamesValuesAndRole(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	sample := fixtureSample(1000)
	m, err := newMetricsExporterWithReader(types.OtelConfig{}, reader, func() *types.SystemMetricsSample { return sample })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) }) //nolint:errcheck // test cleanup

	got := collect(t, reader)
	for _, name := range []string{
		"ion.host.cpu.utilization", "ion.host.memory.available", "ion.host.memory.limit", "ion.host.disk.free",
		"ion.process.cpu.utilization", "ion.process.memory.rss", "ion.engine.heap", "ion.engine.goroutines", "ion.engine.sessions",
	} {
		if _, ok := got[name]; !ok {
			t.Fatalf("instrument %s not exported; got %v", name, got)
		}
	}
	if v := got["ion.host.cpu.utilization"].Data.(metricdata.Gauge[float64]).DataPoints[0].Value; v != 0.4 {
		t.Fatalf("host cpu = %v, want 0.4", v)
	}
	// No container limit: the limit gauge reports physical memory.
	if v := got["ion.host.memory.limit"].Data.(metricdata.Gauge[int64]).DataPoints[0].Value; v != 16<<30 {
		t.Fatalf("memory limit = %v, want physical memory", v)
	}
	rss := got["ion.process.memory.rss"].Data.(metricdata.Gauge[int64]).DataPoints
	byRole := map[string]int64{}
	for _, dp := range rss {
		if dp.Attributes.Len() != 1 {
			t.Fatalf("process metrics must carry role only, got %v", dp.Attributes.ToSlice())
		}
		role, _ := dp.Attributes.Value(attribute.Key("role"))
		byRole[role.AsString()] = dp.Value
	}
	if byRole["mcp"] != 40<<20 || byRole["engine"] != 200<<20 {
		t.Fatalf("rss by role = %v", byRole)
	}
	cpu := got["ion.process.cpu.utilization"].Data.(metricdata.Gauge[float64]).DataPoints
	for _, dp := range cpu {
		if role, _ := dp.Attributes.Value("role"); role.AsString() == "mcp" && dp.Value != 0.25 {
			t.Fatalf("mcp cpu cores = %v, want 0.25", dp.Value)
		}
	}
}

func TestSystemMetricsExportNothingBeforeFirstSample(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	m, err := newMetricsExporterWithReader(types.OtelConfig{}, reader, func() *types.SystemMetricsSample { return nil })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) }) //nolint:errcheck // test cleanup
	if got := collect(t, reader); len(got) != 0 {
		t.Fatalf("no sample yet: want no data points, got %v", got)
	}
}

func TestDeltaTemporalitySelector(t *testing.T) {
	reader := sdkmetric.NewManualReader(sdkmetric.WithTemporalitySelector(temporalitySelector("delta")))
	at := int64(1000)
	var mu sync.Mutex
	source := func() *types.SystemMetricsSample {
		mu.Lock()
		defer mu.Unlock()
		return fixtureSample(at)
	}
	m, err := newMetricsExporterWithReader(types.OtelConfig{}, reader, source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = m.Shutdown(context.Background()) }) //nolint:errcheck // test cleanup
	collect(t, reader)
	mu.Lock()
	at = 2000
	mu.Unlock()
	sum := collect(t, reader)["ion.system_metrics.samples"].Data.(metricdata.Sum[int64])
	if sum.Temporality != metricdata.DeltaTemporality {
		t.Fatalf("temporality = %v, want delta", sum.Temporality)
	}
	if sum.DataPoints[0].Value != 1 {
		t.Fatalf("delta samples = %d, want 1 new sample since the last export", sum.DataPoints[0].Value)
	}
	if temporalitySelector("")(sdkmetric.InstrumentKindObservableCounter) != metricdata.CumulativeTemporality {
		t.Fatal("unset temporality must stay cumulative")
	}
}

func TestMetricsHTTPEndpoint(t *testing.T) {
	cases := []struct {
		cfg  types.OtelConfig
		want string
	}{
		{types.OtelConfig{Endpoint: "http://collector:4318", Metrics: &types.OtelMetricsConfig{}}, "http://collector:4318/v1/metrics"},
		{types.OtelConfig{Endpoint: "https://c.example.org/v1/traces", Metrics: &types.OtelMetricsConfig{}}, "https://c.example.org/v1/metrics"},
		{types.OtelConfig{Endpoint: "https://c.example.org/otlp", Metrics: &types.OtelMetricsConfig{}}, "https://c.example.org/otlp/v1/metrics"},
		{types.OtelConfig{Endpoint: "https://traces.example.org", Metrics: &types.OtelMetricsConfig{
			Endpoint: "https://m.example.org/dcr/streams/Custom-Metrics-Otel/otlp/v1/metrics",
		}}, "https://m.example.org/dcr/streams/Custom-Metrics-Otel/otlp/v1/metrics"},
	}
	for _, c := range cases {
		got, _, err := metricsHTTPEndpoint(c.cfg)
		if err != nil || got != c.want {
			t.Fatalf("metricsHTTPEndpoint(%+v) = %q %v, want %q", c.cfg, got, err, c.want)
		}
	}
}

// TestMetricsExportUsesOwnEndpointAndFreshToken exports through a real OTLP
// HTTP exporter to a test receiver and pins two things an Azure Monitor
// collector depends on: metrics go to the metrics block's own endpoint, and
// each export carries a freshly minted bearer token over a static one.
func TestMetricsExportUsesOwnEndpointAndFreshToken(t *testing.T) {
	var mu sync.Mutex
	var paths, auths []string
	receiver := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		auths = append(auths, r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(receiver.Close)
	withProvider(t, &fakeExpiringProvider{token: "minted"})

	m, err := NewSystemMetricsExporter(types.OtelConfig{
		Endpoint: "http://unused.invalid:4318",
		Headers:  map[string]string{"Authorization": "Bearer static"},
		Metrics: &types.OtelMetricsConfig{
			Enabled: true, ExportIntervalMs: 60_000, Endpoint: receiver.URL + "/streams/metrics",
			Temporality: "delta", TokenScope: "api://collector/.default",
		},
	}, func() *types.SystemMetricsSample { return fixtureSample(time.Now().UnixMilli()) })
	if err != nil {
		t.Fatal(err)
	}
	// Shutdown forces a final export.
	if err := m.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown export: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(paths) == 0 {
		t.Fatal("no export reached the receiver")
	}
	if paths[0] != "/streams/metrics" {
		t.Fatalf("export path = %q, want the metrics block's own endpoint", paths[0])
	}
	if auths[0] != "Bearer minted" {
		t.Fatalf("Authorization = %q, want the freshly minted token", auths[0])
	}
}

func TestNewSystemMetricsExporterRequiresEnabled(t *testing.T) {
	if _, err := NewSystemMetricsExporter(types.OtelConfig{Endpoint: "http://x:4318"}, nil); err == nil {
		t.Fatal("no metrics block: want an error")
	}
}

func TestSystemMetricsRecorderThrottles(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: true, Targets: []string{}})
	record := NewSystemMetricsRecorder(c, time.Minute)
	record(*fixtureSample(1_000))
	record(*fixtureSample(30_000)) // inside the interval: skipped
	record(*fixtureSample(61_000)) // a minute after the first: recorded
	var n int
	for _, e := range c.BufferedEvents() {
		if e.Name == SystemMetrics {
			n++
			if _, ok := e.Payload["host"].(map[string]any); !ok {
				t.Fatalf("payload missing host: %v", e.Payload)
			}
		}
	}
	if n != 2 {
		t.Fatalf("system.metrics events = %d, want 2", n)
	}
}

func TestSystemMetricsRecorderDisabledCollector(t *testing.T) {
	c := NewCollector(types.TelemetryConfig{Enabled: false})
	NewSystemMetricsRecorder(c, time.Minute)(*fixtureSample(1_000))
	NewSystemMetricsRecorder(nil, time.Minute)(*fixtureSample(1_000)) // must not panic
	if len(c.BufferedEvents()) != 0 {
		t.Fatal("a disabled collector must record nothing")
	}
}

func TestMetricsResourceNamesHostAndInstanceUnlessSet(t *testing.T) {
	got := hostResourceAttributes(nil)
	if got["host.name"] == "" {
		t.Fatalf("host.name missing: %v", got)
	}
	if _, ok := got["service.instance.id"]; !ok {
		t.Fatalf("service.instance.id missing: %v", got)
	}
	over := hostResourceAttributes(map[string]string{"host.name": "fleet-01", "team": "platform"})
	if over["host.name"] != "fleet-01" || over["team"] != "platform" {
		t.Fatalf("operator attributes must win: %v", over)
	}
}
