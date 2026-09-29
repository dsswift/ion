package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// Log egress and OTLP export naming the same machine identity share one
// instance. A second build would fail, because the first consumed the
// secret environment variable, and would silently fall back.
func TestTokenSourceResolverBuildsNamedIdentityOnce(t *testing.T) {
	t.Setenv(egressSecretEnv, "s3cret")
	r := newTokenSourceResolver(&types.AuthConfig{
		IdentityProvider: "operator",
		OAuth: map[string]types.OAuthConfig{
			"operator":       {ClientID: "op", TokenURL: "https://idp.example.com/token"},
			"telemetry-ship": machineEntry("https://idp.example.com/token"),
		},
	})
	first := r.resolve("logging.egressTokenProvider", "telemetry-ship")
	second := r.resolve("telemetry.otel.tokenProvider", "telemetry-ship")
	if first.kind != "machine_identity" || second.kind != "machine_identity" {
		t.Fatalf("kinds = %q, %q; want machine_identity for both", first.kind, second.kind)
	}
	if first.provider() != second.provider() {
		t.Fatal("second resolve built a new machine identity instead of sharing the first")
	}
}

// A headless engine whose telemetry.otel names a machine identity puts that
// identity's token on the metrics export.
func TestOtelMachineIdentityAuthorizesMetricsExport(t *testing.T) {
	t.Setenv(egressSecretEnv, "s3cret")
	var tokenScope sync.Map
	tokenSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		tokenScope.Store("scope", r.PostForm.Get("scope"))
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "otel-token-123", "token_type": "Bearer", "expires_in": 3600}) //nolint:errcheck // test server
	}))
	t.Cleanup(tokenSrv.Close)

	var mu sync.Mutex
	var authHeaders []string
	sink := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		authHeaders = append(authHeaders, r.Header.Get("Authorization"))
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(sink.Close)

	otel := &types.OtelConfig{
		Enabled: true, Endpoint: sink.URL,
		TokenScope: "api://collector/.default", TokenProvider: "telemetry-ship",
		Metrics: &types.OtelMetricsConfig{Enabled: true, ExportIntervalMs: 60_000},
	}
	cfg := &types.EngineRuntimeConfig{
		Auth:      &types.AuthConfig{OAuth: map[string]types.OAuthConfig{"telemetry-ship": machineEntry(tokenSrv.URL)}},
		Telemetry: &types.TelemetryConfig{Enabled: true, Otel: otel},
	}
	installOtelExportAuth(cfg, newTokenSourceResolver(cfg.Auth))

	exporter, err := telemetry.NewSystemMetricsExporter(*otel, func() *types.SystemMetricsSample {
		return &types.SystemMetricsSample{SampledAt: time.Now().UnixMilli()}
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := exporter.Shutdown(context.Background()); err != nil {
		t.Fatalf("shutdown export: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(authHeaders) == 0 {
		t.Fatal("no metrics export reached the sink")
	}
	if authHeaders[0] != "Bearer otel-token-123" {
		t.Fatalf("metrics Authorization = %q, want the machine identity token", authHeaders[0])
	}
	if got, _ := tokenScope.Load("scope"); got != "api://collector/.default" {
		t.Fatalf("token request scope = %v, want the otel tokenScope", got)
	}
}
