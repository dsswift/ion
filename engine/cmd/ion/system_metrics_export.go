package main

import (
	"context"
	"time"

	"github.com/dsswift/ion/engine/internal/sysmetrics"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// startSystemMetricsExport connects the System Metrics sampler to the
// engine's off-machine outputs, each only when configured:
//
//   - a system.metrics telemetry event every systemMetrics.telemetryIntervalMs
//     while the process telemetry collector is enabled;
//   - OTLP metrics when telemetry.otel.metrics.enabled is true.
//
// Nothing leaves the machine otherwise.
//
// It returns a stop function for shutdown (a no-op when nothing started).
func startSystemMetricsExport(cfg *types.EngineRuntimeConfig, collector *telemetry.Collector, sampler *sysmetrics.Sampler) func() {
	if collector != nil {
		interval := time.Duration(sysmetrics.DefaultTelemetryIntervalMs) * time.Millisecond
		if cfg.SystemMetrics != nil && cfg.SystemMetrics.TelemetryIntervalMs > 0 {
			interval = time.Duration(cfg.SystemMetrics.TelemetryIntervalMs) * time.Millisecond
		}
		record := telemetry.NewSystemMetricsRecorder(collector, interval)
		sampler.AddListener(func(sample types.SystemMetricsSample, _ []string) { record(sample) })
		utils.LogWithFields(utils.LevelInfo, "serve", "system.metrics telemetry events enabled", map[string]any{"interval_ms": interval.Milliseconds()})
	} else {
		utils.Log("serve", "system.metrics telemetry events off: telemetry disabled")
	}

	if cfg.Telemetry == nil || !cfg.Telemetry.Enabled || cfg.Telemetry.Otel == nil || cfg.Telemetry.Otel.Metrics == nil || !cfg.Telemetry.Otel.Metrics.Enabled {
		utils.Log("serve", "otlp metrics export off: telemetry.otel.metrics not enabled")
		return func() {}
	}
	exporter, err := telemetry.NewSystemMetricsExporter(*cfg.Telemetry.Otel, sampler.Latest)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "serve", "otlp metrics export failed to start", map[string]any{"error": err.Error()})
		return func() {}
	}
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), metricsExportShutdownTimeout)
		defer cancel()
		if err := exporter.Shutdown(ctx); err != nil {
			utils.LogWithFields(utils.LevelWarn, "serve", "otlp metrics export shutdown failed", map[string]any{"error": err.Error()})
		}
	}
}
