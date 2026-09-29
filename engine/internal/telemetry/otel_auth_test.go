package telemetry

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// withOtelTokenSource registers a named source for one test.
func withOtelTokenSource(t *testing.T, name string, p auth.TokenProvider) {
	t.Helper()
	SetOtelTokenSource(name, OtelTokenSource{Name: name, Kind: "machine_identity", Provider: func() auth.TokenProvider { return p }})
	t.Cleanup(func() {
		otelTokenSourcesMu.Lock()
		delete(otelTokenSources, name)
		otelTokenSourcesMu.Unlock()
	})
}

// authRecorder is an OTLP/HTTP receiver that records each Authorization header.
type authRecorder struct {
	mu    sync.Mutex
	auths []string
	srv   *httptest.Server
}

func newAuthRecorder(t *testing.T) *authRecorder {
	t.Helper()
	r := &authRecorder{}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.mu.Lock()
		r.auths = append(r.auths, req.Header.Get("Authorization"))
		r.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *authRecorder) first(t *testing.T) string {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.auths) == 0 {
		t.Fatal("no export reached the receiver")
	}
	return r.auths[0]
}

func exportMetricsOnce(t *testing.T, cfg types.OtelConfig) {
	t.Helper()
	m, err := NewSystemMetricsExporter(cfg, func() *types.SystemMetricsSample { return fixtureSample(time.Now().UnixMilli()) })
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown export: %v", err)
	}
}

// A named tokenProvider mints the metrics token from its registered
// credential, not the identity provider, using the shared tokenScope when the
// metrics block sets none.
func TestMetricsExportMintsFromNamedTokenProvider(t *testing.T) {
	rec := newAuthRecorder(t)
	withProvider(t, &fakeExpiringProvider{token: "operator"})
	machine := &fakeExpiringProvider{token: "workload"}
	withOtelTokenSource(t, "orion-telemetry", machine)

	exportMetricsOnce(t, types.OtelConfig{
		Endpoint:      rec.srv.URL,
		TokenScope:    "api://collector/.default",
		TokenProvider: "orion-telemetry",
		Metrics:       &types.OtelMetricsConfig{Enabled: true, ExportIntervalMs: 60_000},
	})
	if got := rec.first(t); got != "Bearer workload" {
		t.Fatalf("Authorization = %q, want the named provider's token", got)
	}
	if machine.gotScope != "api://collector/.default" {
		t.Fatalf("minted scope = %q, want the shared tokenScope", machine.gotScope)
	}
}

// Unset tokenProvider keeps the identity provider, whatever is registered.
func TestMetricsExportUnsetTokenProviderUsesIdentity(t *testing.T) {
	rec := newAuthRecorder(t)
	withProvider(t, &fakeExpiringProvider{token: "operator"})
	withOtelTokenSource(t, "orion-telemetry", &fakeExpiringProvider{token: "workload"})

	exportMetricsOnce(t, types.OtelConfig{
		Endpoint: rec.srv.URL,
		Metrics:  &types.OtelMetricsConfig{Enabled: true, ExportIntervalMs: 60_000, TokenScope: "api://collector/.default"},
	})
	if got := rec.first(t); got != "Bearer operator" {
		t.Fatalf("Authorization = %q, want the identity provider's token", got)
	}
}

// A name nobody registered falls back to the identity provider.
func TestOtelTokenProviderUnregisteredFallsBack(t *testing.T) {
	withProvider(t, &fakeExpiringProvider{token: "operator"})
	p, kind := otelTokenProvider("never-registered")
	if kind != "identity_provider" || p == nil {
		t.Fatalf("got kind %q provider %v, want identity provider", kind, p)
	}
}

func TestMetricsTokenScopePrecedence(t *testing.T) {
	cases := []struct {
		name string
		cfg  types.OtelConfig
		want string
	}{
		{"none", types.OtelConfig{Metrics: &types.OtelMetricsConfig{}}, ""},
		{"shared", types.OtelConfig{TokenScope: "shared", Metrics: &types.OtelMetricsConfig{}}, "shared"},
		{"metrics wins", types.OtelConfig{TokenScope: "shared", Metrics: &types.OtelMetricsConfig{TokenScope: "own"}}, "own"},
	}
	for _, tc := range cases {
		if got := metricsTokenScope(tc.cfg); got != tc.want {
			t.Errorf("%s: scope = %q, want %q", tc.name, got, tc.want)
		}
	}
}

// Trace export through the collector carries a token from the named provider
// when telemetry.otel sets tokenScope and tokenProvider.
func TestCollectorTraceExportMintsFromNamedTokenProvider(t *testing.T) {
	rec := newAuthRecorder(t)
	withProvider(t, &fakeExpiringProvider{token: "operator"})
	withOtelTokenSource(t, "orion-telemetry", &fakeExpiringProvider{token: "workload"})

	bridge := NewOtelBridge(OtelConfig{
		Endpoint: rec.srv.URL, Protocol: otlpProtocolHTTPProtobuf, BatchSize: 1,
		TokenScope: "api://collector/.default", TokenProvider: "orion-telemetry",
	})
	bridge.RecordEvent(Event{Name: "telemetry.auth", Ts: time.Now().UTC().Format(time.RFC3339Nano)})
	if err := bridge.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := rec.first(t); got != "Bearer workload" {
		t.Fatalf("trace Authorization = %q, want the named provider's token", got)
	}
}

// Without tokenScope the trace export sends only static headers, as before.
func TestTraceExportWithoutTokenScopeSendsNoMintedToken(t *testing.T) {
	rec := newAuthRecorder(t)
	withProvider(t, &fakeExpiringProvider{token: "operator"})
	bridge := NewOtelBridge(OtelConfig{Endpoint: rec.srv.URL, Protocol: otlpProtocolHTTPProtobuf, BatchSize: 1})
	bridge.RecordEvent(Event{Name: "telemetry.auth", Ts: time.Now().UTC().Format(time.RFC3339Nano)})
	if err := bridge.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := rec.first(t); got != "" {
		t.Fatalf("trace Authorization = %q, want none", got)
	}
}

// NewCollector passes the telemetry.otel token fields to the trace bridge.
func TestNewCollectorPassesOtelTokenFields(t *testing.T) {
	rec := newAuthRecorder(t)
	c := NewCollector(types.TelemetryConfig{
		Enabled: true, Targets: []string{"otel"},
		Otel: &types.OtelConfig{Enabled: true, Endpoint: rec.srv.URL, TokenScope: "s", TokenProvider: "orion-telemetry"},
	})
	t.Cleanup(func() { c.Close() })
	if c.otelBridge == nil {
		t.Fatal("otel bridge not configured")
	}
	if c.otelBridge.config.TokenScope != "s" || c.otelBridge.config.TokenProvider != "orion-telemetry" {
		t.Fatalf("bridge config = %+v", c.otelBridge.config)
	}
}
