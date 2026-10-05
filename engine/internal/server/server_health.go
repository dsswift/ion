package server

import (
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
)

// healthSnapshot returns daemon liveness data for the health command.
func (s *Server) healthSnapshot() map[string]interface{} {
	version := s.version
	if version == "" {
		version = "dev"
	}
	out := map[string]interface{}{
		"ok":           true,
		"version":      version,
		"startedAt":    s.startedAt.UTC().Format(time.RFC3339),
		"uptimeSec":    int64(time.Since(s.startedAt).Seconds()),
		"sessionCount": len(s.manager.ListSessions()),
		"socketPath":   s.socketPath,
		// telemetryHealth is the current delivery health of each telemetry
		// collector's network targets; empty when none is configured.
		"telemetryHealth": s.telemetryHealthSnapshot(),
		// compat is this running engine's Format Versions registry.
		"compat": compat.Formats(),
	}
	// systemMetrics is the latest System Metrics sample. Absent when
	// sampling is disabled or no sample has been taken yet; health never
	// takes a sample itself, so it stays cheap.
	if sampler := s.SystemMetrics(); sampler != nil {
		if latest := sampler.Latest(); latest != nil {
			out["systemMetrics"] = latest
		}
	}
	return out
}
