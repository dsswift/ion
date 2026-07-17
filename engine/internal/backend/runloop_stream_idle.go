package backend

import (
	"github.com/dsswift/ion/engine/internal/providers"
)

// runloop_stream_idle.go — installs the provider stream-idle deadline for a
// run from its resolved TimeoutsConfig.
//
// The providers package reads the deadline via a package-level atomic
// (SetStreamIdleTimeout, mirroring runProgressWatchdogTickNanos), so the
// streaming hot path reads a plain int64 rather than threading config through
// every provider's Stream signature — which would be a wire/interface contract
// change. In production every run shares the engine's single TimeoutsConfig, so
// the global is effectively stable; it is re-asserted per run so a config
// reload takes effect on the next run without a process restart.
//
// Extracted to its own file (rather than inlined in the allowlisted-near-cap
// runloop.go) per the file-organization rule that new code goes in a new file.
func installStreamIdleTimeout(run *activeRun) {
	if run == nil || run.cfg == nil || run.cfg.Timeouts == nil {
		// No per-run timeouts config: leave whatever default the providers
		// package already has (its own 90s compiled default). Do not reset —
		// a prior run on this process may have installed a valid value.
		installStreamTelemetry(run)
		return
	}
	if d, enabled := run.cfg.Timeouts.StreamIdle(); enabled {
		providers.SetStreamIdleTimeout(d)
	} else {
		providers.SetStreamIdleTimeout(-1) // negative disables the deadline
	}
	installStreamTelemetry(run)
}

// installStreamTelemetry installs (or clears) the process-wide provider stream
// telemetry sink from the run's telemetry collector. Like the stream-idle
// deadline, the providers package reads this via a package-level setter rather
// than threading a collector through every Stream signature (which would be an
// interface contract change). Re-asserted per run so a run with telemetry
// enabled installs the sink and a run without it leaves the last sink in place
// (nil-safe: the sink adapter guards on a nil collector). When the run has no
// telemetry the sink is cleared so a stale collector from a prior run does not
// receive this run's stream events.
func installStreamTelemetry(run *activeRun) {
	if run == nil || run.cfg == nil || run.cfg.Telemetry == nil {
		providers.SetStreamTelemetry(nil)
		return
	}
	providers.SetStreamTelemetry(streamTelemetrySink{c: run.cfg.Telemetry})
}

// streamTelemetrySink adapts a backend.TelemetryCollector to the providers
// package's StreamTelemetrySink interface. Both Event signatures take
// map[string]any, so the adapter is a thin pass-through.
type streamTelemetrySink struct {
	c TelemetryCollector
}

func (s streamTelemetrySink) Event(name string, payload, ctx map[string]any) {
	if s.c == nil {
		return
	}
	s.c.Event(name, payload, ctx)
}
