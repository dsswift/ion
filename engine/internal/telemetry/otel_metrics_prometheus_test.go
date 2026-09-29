package telemetry

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestSystemMetricsReachPrometheus exports System Metrics to a real
// Prometheus through its native OTLP receiver and reads them back with
// PromQL, the path the local observability stack uses
// (docs/observability/docker-compose.yml). It runs only when
// ION_TEST_PROMETHEUS_URL names that Prometheus, e.g.
// http://localhost:9090, because it needs the container.
func TestSystemMetricsReachPrometheus(t *testing.T) {
	base := os.Getenv("ION_TEST_PROMETHEUS_URL")
	if base == "" {
		t.Skip("set ION_TEST_PROMETHEUS_URL to a Prometheus started with --web.enable-otlp-receiver")
	}
	instance := "sysmetrics-e2e-" + time.Now().Format("150405.000")
	m, err := NewSystemMetricsExporter(types.OtelConfig{
		ServiceName:        "ion-engine",
		ResourceAttributes: map[string]string{"service.instance.id": instance},
		Metrics:            &types.OtelMetricsConfig{Enabled: true, Endpoint: base + "/api/v1/otlp/v1/metrics"},
	}, func() *types.SystemMetricsSample { return fixtureSample(time.Now().UnixMilli()) })
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Shutdown(context.Background()); err != nil {
		t.Fatalf("export to prometheus: %v", err)
	}

	query := func(q string) []any {
		resp, err := http.Get(base + "/api/v1/query?query=" + url.QueryEscape(q))
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close() //nolint:errcheck // read-only test response
		var body struct {
			Data struct {
				Result []any `json:"result"`
			} `json:"data"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return body.Data.Result
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		cpu := query(`{__name__=~"ion_host_cpu_utilization.*", service_instance_id="` + instance + `"}`)
		rss := query(`{__name__=~"ion_process_memory_rss.*", service_instance_id="` + instance + `", role="mcp"}`)
		if len(cpu) == 1 && len(rss) == 1 {
			t.Logf("prometheus returned host cpu %v and mcp rss %v", cpu[0], rss[0])
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("gauges not queryable: cpu=%v rss=%v", cpu, rss)
		}
		time.Sleep(500 * time.Millisecond)
	}
}
