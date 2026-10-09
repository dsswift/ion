package server

import (
	"time"

	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// startupTrace is the daemon's own trace: daemon.startup is its root, from
// process start to the socket accepting clients, with config.load and
// provider.probe as children. The config read happens before any collector
// exists (the config is what enables telemetry), so the phases are timed
// first and recorded retroactively through StartSpanCtxAt / EndAt.
type startupTrace struct {
	traceID      string
	spanID       string
	processStart time.Time
	configStart  time.Time
	configEnd    time.Time
	configPath   string
	// recordedConfig is set once config.load has been written, so a second
	// SetConfig (tests, a reload) does not emit it twice.
	recordedConfig bool
	// ended is set once daemon.startup has been written.
	ended bool
}

// SetStartupTiming hands the server the instants the serve command measured
// before it existed: when the process started and when the config read began
// and ended. Call it before SetConfig so the config.load span is recorded as
// soon as the collector exists.
func (s *Server) SetStartupTiming(processStart, configStart, configEnd time.Time, configPath string) {
	s.mu.Lock()
	s.startup = &startupTrace{
		traceID:      utils.NewTraceID(),
		spanID:       utils.NewSpanID(),
		processStart: processStart,
		configStart:  configStart,
		configEnd:    configEnd,
		configPath:   configPath,
	}
	trace := *s.startup
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "server.startup", "daemon startup trace minted", map[string]any{
		"trace_id": trace.traceID, "span_id": trace.spanID, "process_start": trace.processStart.UTC().Format(time.RFC3339Nano),
	})
}

// startupSpanCtx is the correlation context for a span under daemon.startup,
// or nil when no startup trace was set (a server built without the serve
// command, as in tests) or start-up is over: work begun after the socket
// accepts clients is not part of the daemon's start.
func (s *Server) startupSpanCtx() map[string]any {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.startup == nil || s.startup.ended {
		return nil
	}
	return map[string]any{"trace_id": s.startup.traceID, "parent_span_id": s.startup.spanID}
}

// recordConfigLoadSpan writes the config.load span from the timing
// SetStartupTiming recorded. Called from SetConfig once the collector exists;
// a nil collector or no timing records nothing.
func (s *Server) recordConfigLoadSpan(telem *telemetry.Collector) {
	s.mu.Lock()
	trace := s.startup
	if telem == nil || trace == nil || trace.recordedConfig || trace.configStart.IsZero() {
		s.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "server.startup", "config.load span skipped", map[string]any{
			"collector": telem != nil, "timing": trace != nil && !trace.configStart.IsZero(), "already_recorded": trace != nil && trace.recordedConfig,
		})
		return
	}
	trace.recordedConfig = true
	ctx := map[string]any{"trace_id": trace.traceID, "parent_span_id": trace.spanID}
	start, end, path := trace.configStart, trace.configEnd, trace.configPath
	s.mu.Unlock()
	span := telem.StartSpanCtxAt(telemetry.ConfigLoad, map[string]any{"path": path}, ctx, start)
	span.EndAt(end, nil)
	utils.LogWithFields(utils.LevelInfo, "server.startup", "config.load span recorded", map[string]any{
		"trace_id": ctx["trace_id"], "span_id": span.SpanID(), "duration_ms": float64(end.Sub(start).Microseconds()) / 1000.0,
	})
}

// endStartupSpan writes daemon.startup, process start to now. Called from
// Start once the listener accepts. Nothing is written without a collector or
// a startup trace; a second call is a no-op.
func (s *Server) endStartupSpan() {
	s.mu.Lock()
	trace := s.startup
	telem := s.telemetry
	if trace == nil || trace.ended {
		s.mu.Unlock()
		return
	}
	trace.ended = true
	traceID, spanID, start := trace.traceID, trace.spanID, trace.processStart
	s.mu.Unlock()
	if telem == nil {
		utils.LogWithFields(utils.LevelDebug, "server.startup", "daemon.startup span skipped: telemetry disabled", map[string]any{"trace_id": traceID})
		return
	}
	span := telem.StartSpanCtxAt(telemetry.DaemonStartup, map[string]any{
		"socket": s.socketPath, "span_kind": telemetry.SpanKindServer,
	}, map[string]any{"trace_id": traceID}, start).WithSpanID(spanID)
	span.End(nil)
	utils.LogWithFields(utils.LevelInfo, "server.startup", "daemon.startup span recorded", map[string]any{
		"trace_id": traceID, "span_id": spanID, "duration_ms": float64(time.Since(start).Microseconds()) / 1000.0,
	})
}
