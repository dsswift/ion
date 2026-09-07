package server

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatch_telemetry_health.go projects a Collector's delivery health onto
// the engine wire as engine_telemetry_health (issue #379).
//
// The telemetry package cannot emit this itself: it is a leaf package with no
// access to the server's connection set, and giving it one would invert the
// dependency. So it reports structured snapshots to an observer, and this
// file is the observer the server installs — the same shape the conversation
// emitter uses for its before-event hook.
//
// The event is broadcast with an empty session key because delivery health is
// process-level. A backlog belongs to the engine's egress target, not to
// whichever conversation happened to be running when it was noticed.

// installTelemetryHealthObserver wires a collector's health reports to the
// engine wire. Safe to call for a collector with no network target: the
// observer is simply never invoked.
func (s *Server) installTelemetryHealthObserver(collector *telemetry.Collector, source string) {
	if collector == nil {
		return
	}
	collector.SetHealthObserver(func(h telemetry.TelemetryHealth) {
		s.broadcastTelemetryHealth(h, source)
	})
}

// broadcastTelemetryHealth serializes one health snapshot to every connected
// client.
func (s *Server) broadcastTelemetryHealth(h telemetry.TelemetryHealth, source string) {
	evt := types.EngineEvent{
		Type:                       "engine_telemetry_health",
		TelemetryTarget:            h.Target,
		TelemetryQueuedBatches:     h.QueuedBatches,
		TelemetryQueuedEvents:      h.QueuedEvents,
		TelemetryQueuedBytes:       h.QueuedBytes,
		TelemetryOldestAgeMs:       h.OldestAgeMs,
		TelemetrySoftWarnBytes:     h.SoftWarnBytes,
		TelemetryPercentOfSoftWarn: h.PercentOfSoftWarn,
		TelemetryCrossedThreshold:  h.CrossedThreshold,
		TelemetryHealthy:           h.Healthy,
		TelemetryLastError:         h.LastError,
		TelemetryCritical:          h.Critical,
		TelemetryStuck:             h.Stuck,
		TelemetryStuckAfterMs:      h.StuckAfterMs,
		TelemetryMaxAttempts:       h.MaxAttempts,
		TelemetryQuarantinedEvents: h.QuarantinedEvents,
		TelemetryQuarantinedBytes:  h.QuarantinedBytes,
	}
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.telemetry_health", "telemetry health marshal failed", map[string]any{
			"error": err.Error(), "target": h.Target, "source": source,
		})
		return
	}
	s.broadcast(protocol.SerializeServerEvent("", json.RawMessage(raw)), evt.Type)

	// Logged at WARN for a critical, stuck, or quarantine condition and INFO
	// otherwise: those three are losing or withholding data now, whereas a
	// growing backlog is a condition to watch. All are logged
	// unconditionally, so an operator with no client attached still has the
	// record.
	level := utils.LevelInfo
	if h.Critical || h.Stuck || h.QuarantinedEvents > 0 {
		level = utils.LevelWarn
	}
	utils.LogWithFields(level, "server.telemetry_health", "telemetry health broadcast", map[string]any{
		"source": source, "target": h.Target, "healthy": h.Healthy,
		"queued_events": h.QueuedEvents, "queued_bytes": h.QueuedBytes,
		"percent_of_soft_warn": h.PercentOfSoftWarn, "crossed_threshold": h.CrossedThreshold,
		"oldest_age_ms": h.OldestAgeMs, "max_attempts": h.MaxAttempts, "stuck": h.Stuck,
		"quarantined_events": h.QuarantinedEvents, "critical": h.Critical,
	})
}
