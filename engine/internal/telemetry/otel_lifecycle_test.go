package telemetry

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestNewCollectorConfiguresOtelBridgeLifecycle verifies that the production
// telemetry configuration creates, schedules, flushes, and closes its OTLP
// bridge. The bridge uses the configured OTLP HTTP/protobuf traces endpoint.
func TestNewCollectorConfiguresOtelBridgeLifecycle(t *testing.T) {
	requests := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			t.Errorf("read OTLP request body: %v", err)
		}
		requests <- r
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	collector := NewCollector(types.TelemetryConfig{
		Enabled:         true,
		Targets:         []string{"otel"},
		FlushIntervalMs: 60_000,
		Otel: &types.OtelConfig{
			Enabled:     true,
			Endpoint:    server.URL,
			Headers:     map[string]string{"X-OTLP-Test": "configured"},
			ServiceName: "telemetry-test",
		},
	})

	if collector.otelBridge == nil {
		t.Fatal("NewCollector did not construct the configured OTLP bridge")
	}
	if collector.flushTicker == nil {
		t.Fatal("NewCollector did not schedule periodic flushing for the OTLP target")
	}

	collector.Event("telemetry.configured", map[string]any{"source": "test"}, nil)
	if err := collector.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}

	select {
	case request := <-requests:
		if got, want := request.URL.Path, "/v1/traces"; got != want {
			t.Errorf("OTLP request path = %q, want %q", got, want)
		}
		if got, want := request.Header.Get("Content-Type"), "application/x-protobuf"; got != want {
			t.Errorf("OTLP content type = %q, want %q", got, want)
		}
		if got, want := request.Header.Get("X-OTLP-Test"), "configured"; got != want {
			t.Errorf("OTLP custom header = %q, want %q", got, want)
		}
		select {
		case unexpected := <-requests:
			t.Errorf("collector Flush exported OTLP more than once to %q", unexpected.URL)
		default:
		}
	case <-time.After(time.Second):
		t.Fatal("collector Flush did not export the configured OTLP bridge")
	}

	collector.Close()
	collector.Close()

	select {
	case <-collector.otelBridge.flushDone:
		// The bridge loop stopped during collector shutdown.
	default:
		t.Fatal("collector Close did not stop the OTLP bridge")
	}
}

func TestNewCollectorSkipsUnconfiguredOtelTarget(t *testing.T) {
	collector := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"otel"},
		Otel:    &types.OtelConfig{Enabled: true},
	})
	t.Cleanup(collector.Close)

	if collector.otelBridge != nil {
		t.Fatal("NewCollector constructed an OTLP bridge without an endpoint")
	}
	if collector.flushTicker != nil {
		t.Fatal("NewCollector scheduled flushing for an unconfigured OTLP target")
	}
}
