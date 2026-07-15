package providers

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// sse_idle.go — the provider stream-idle deadline and heartbeat.
//
// Why this exists. The shared HTTP transport (internal/network) already caps
// the wait for the FIRST response byte (ResponseHeaderTimeout) and forces
// HTTP/2 PINGs so a silently-dead connection is detected. Neither protects
// against a stream that returns headers and then stops emitting SSE bytes
// while the upstream keeps the H2 stream alive at the protocol level: the
// provider read loop (`for sse := range sseCh`) blocks forever with no output
// and no error. That was the originating failure in the
// 1782088921498-960b064fe896 incident — ~7 minutes of total silence before an
// external watchdog intervened.
//
// streamWithIdle wraps the raw SSE channel from ParseSSEStream with a
// per-event idle timer. Every received event resets the timer; if the gap
// between events exceeds the configured idle deadline, the wrapper stops and
// reports a RETRYABLE stream error (ErrStreamTruncated, tagged stream_idle) so
// the existing WithRetry machinery re-streams transparently. It also emits a
// periodic heartbeat log and invokes an optional progress callback so a
// healthy-but-slow stream is observable in engine.log and keeps the run's
// progress clock fresh (so the run-progress watchdog does not mistake a slow
// stream for a stall).
//
// The mechanism is engine-owned and generic; the threshold is the opinion,
// configured via TimeoutsConfig.StreamIdle() and installed once through
// SetStreamIdleTimeout (mirroring the backend's runProgressWatchdogTickNanos
// pattern — a package-level atomic default with a setter, so the hot streaming
// path reads a plain int64 rather than threading config through every
// provider's Stream signature, which would be a contract change).

// streamIdleNanos is the configured per-event idle deadline in nanoseconds.
// 0 means "use the compiled default"; a negative value disables the deadline.
// Stored atomically because SetStreamIdleTimeout (called from session/backend
// setup) races the long-lived provider stream goroutines that read it.
var streamIdleNanos atomic.Int64

// streamHeartbeatNanos is the heartbeat log cadence. Fixed; not user-tunable —
// it is pure observability and has no behavioral effect.
const streamHeartbeatInterval = 15 * time.Second

// defaultStreamIdle mirrors TimeoutsConfig.StreamIdle()'s compiled default
// (90s). Defined here so the providers package has a self-contained default
// when no setter has run (e.g. unit tests that call streamWithIdle directly).
const defaultStreamIdle = 90 * time.Second

// SetStreamIdleTimeout installs the per-event SSE idle deadline used by all
// provider streams. Call once at engine/session startup from
// TimeoutsConfig.StreamIdle(). A non-positive duration disables the deadline
// (the wrapper relies solely on the transport + the run-progress watchdog).
func SetStreamIdleTimeout(d time.Duration) {
	streamIdleNanos.Store(int64(d))
	utils.LogWithFields(utils.LevelInfo, "providers", "set stream idle timeout", map[string]any{"duration_ms": d.Milliseconds()})
}

// resolvedStreamIdle reads the configured deadline, falling back to the
// compiled default when unset (0). A negative stored value disables it.
func resolvedStreamIdle() (time.Duration, bool) {
	v := streamIdleNanos.Load()
	if v < 0 {
		return 0, false
	}
	if v == 0 {
		return defaultStreamIdle, true
	}
	return time.Duration(v), true
}

// StreamTelemetrySink is the minimal telemetry surface the provider stream
// wrapper emits to. It mirrors telemetry.Collector.Event without importing the
// telemetry package (which would create an import cycle: telemetry is a leaf
// consumed by the session/backend layers, and providers must stay
// dependency-light). The session/backend layer installs a concrete sink via
// SetStreamTelemetry at engine startup, adapting its telemetry.Collector.
type StreamTelemetrySink interface {
	Event(name string, payload, ctx map[string]any)
}

// streamTelemetry holds the process-wide stream telemetry sink. Guarded by
// streamTelemetryMu because SetStreamTelemetry (called once at startup) races
// the long-lived provider stream goroutines that read it. Nil until installed;
// nil means stream stall/summary telemetry is disabled (the events are pure
// observability and have no behavioral effect).
var (
	streamTelemetry   StreamTelemetrySink
	streamTelemetryMu sync.RWMutex
)

// SetStreamTelemetry installs the process-wide telemetry sink for provider
// stream stall / summary events. Pass nil to disable. Idempotent; a later call
// replaces the sink. Mirrors SetStreamIdleTimeout's setter pattern.
func SetStreamTelemetry(sink StreamTelemetrySink) {
	streamTelemetryMu.Lock()
	streamTelemetry = sink
	streamTelemetryMu.Unlock()
}

// resolvedStreamTelemetry reads the installed sink under the lock.
func resolvedStreamTelemetry() StreamTelemetrySink {
	streamTelemetryMu.RLock()
	defer streamTelemetryMu.RUnlock()
	return streamTelemetry
}

// telemetryCorrelationKey is the unexported context key under which the backend
// stashes the run's telemetry correlation block (session_id / conversation_id /
// run_id / model) so the provider stream layer can attribute provider.stall and
// provider.stream_summary events to the originating conversation. A dedicated
// unexported type prevents collisions with any other context value.
type telemetryCorrelationKey struct{}

// WithTelemetryCorrelation returns a child context carrying the telemetry
// correlation block for the run about to stream. The provider stream wrapper
// reads it via telemetryCorrelationFromContext and stamps it on the stall /
// summary events so forensics ("provider trouble" scoring) can join those
// events to the conversation. Passing a nil map is a no-op (returns ctx
// unchanged), so callers without a correlation block are unaffected.
//
// This is the ctx-value complement to SetStreamTelemetry's package-level sink:
// the sink is process-wide, but the correlation is per-run, so it must travel
// with the request context rather than a global.
func WithTelemetryCorrelation(ctx context.Context, correlation map[string]any) context.Context {
	if ctx == nil || correlation == nil {
		return ctx
	}
	return context.WithValue(ctx, telemetryCorrelationKey{}, correlation)
}

// telemetryCorrelationFromContext extracts the correlation block stashed by
// WithTelemetryCorrelation. Returns nil when absent (direct provider calls,
// unit tests) so the stall / summary events fall back to an unattributed emit.
func telemetryCorrelationFromContext(ctx context.Context) map[string]any {
	if ctx == nil {
		return nil
	}
	if v, ok := ctx.Value(telemetryCorrelationKey{}).(map[string]any); ok {
		return v
	}
	return nil
}

// streamProgress is an optional callback invoked on every received SSE event
// and on every heartbeat tick, so the caller (the run loop) can keep its
// progress clock fresh while a slow-but-alive stream is in flight. Nil-safe.
type streamProgress func()

// streamWithIdle consumes the raw SSE channel and re-emits its events on the
// returned channel, enforcing the per-event idle deadline and emitting
// heartbeat logs. The returned errFn (call after draining) reports:
//   - the idle-deadline error (retryable stream_truncated, tagged stream_idle)
//     when the gap between events exceeded the deadline,
//   - otherwise whatever the underlying srcErr() reports (clean EOF → nil,
//     transport error → that error).
//
// tag/model/requestID are logging context only. onProgress may be nil.
// correlationCtx (nil-safe) is stamped on the provider.stall and
// provider.stream_summary telemetry events so they attribute to the
// originating conversation (session_id / conversation_id / run_id). Callers
// without a run context pass nil, and the events emit unattributed as before.
func streamWithIdle(
	src <-chan SSEEvent,
	srcErr func() error,
	tag, model, requestID string,
	onProgress streamProgress,
	correlationCtx map[string]any,
) (<-chan SSEEvent, func() error) {
	out := make(chan SSEEvent, 16)

	idle, idleEnabled := resolvedStreamIdle()

	var (
		idleErr *ProviderError
		doneCh  = make(chan struct{})
	)

	// INFO, not DEBUG: engine.jsonl carries INFO and above, and this line is
	// the marker that the run entered the provider stream. Without it the log
	// is silent from prompt assembly until the first stream outcome, which is
	// indistinguishable from a hang (the blind spot behind the
	// 1783901108497-c95abcd11560 investigation).
	utils.LogWithFields(utils.LevelInfo, tag, "stream start", map[string]any{
		"model": model, "request_id": requestID, "duration_ms": idle.Milliseconds(), "status": idleEnabled,
	})

	go func() {
		defer close(out)
		defer close(doneCh)

		// Idle timer. When disabled, idleC stays nil so the select arm never
		// fires (a nil channel blocks forever).
		var idleTimer *time.Timer
		var idleC <-chan time.Time
		if idleEnabled {
			idleTimer = time.NewTimer(idle)
			idleC = idleTimer.C
			defer idleTimer.Stop()
		}

		heartbeat := time.NewTicker(streamHeartbeatInterval)
		defer heartbeat.Stop()

		start := time.Now()
		lastEventAt := start
		eventCount := 0
		var maxGap time.Duration

		for {
			select {
			case sse, ok := <-src:
				if !ok {
					// Source drained (EOF or read error). errFn defers to
					// srcErr below. Log the clean end for observability — INFO
					// to pair with the INFO "stream start" (log both sides).
					elapsed := time.Since(start)
					utils.LogWithFields(utils.LevelInfo, tag, "stream end", map[string]any{
						"model": model, "request_id": requestID, "count": eventCount, "duration_ms": elapsed.Milliseconds(),
					})
					// provider.stream_summary telemetry (family 4d): a per-stream
					// rollup on clean drain. Pure observability; nil-safe.
					// R11: event name is carried by Event.Name; payload.kind removed.
					if sink := resolvedStreamTelemetry(); sink != nil {
						sink.Event("provider.stream_summary", map[string]any{
							"model":       model,
							"request_id":  requestID,
							"event_count": eventCount,
							"duration_ms": elapsed.Milliseconds(),
							"max_gap_ms":  maxGap.Milliseconds(),
						}, correlationCtx)
					}
					return
				}
				eventCount++
				now := time.Now()
				if gap := now.Sub(lastEventAt); gap > maxGap {
					maxGap = gap
				}
				lastEventAt = now
				if onProgress != nil {
					onProgress()
				}
				// Reset the idle timer for the next event.
				if idleEnabled {
					if !idleTimer.Stop() {
						// Drain a possibly-fired timer so Reset is clean.
						select {
						case <-idleTimer.C:
						default:
						}
					}
					idleTimer.Reset(idle)
				}
				// Forward downstream. The consumer reads with its own ctx
				// select; here we just block on out, which the consumer
				// drains promptly.
				out <- sse

			case <-idleC:
				// No event for longer than the idle deadline. The upstream is
				// holding the stream open but sending nothing. Surface a
				// retryable error so WithRetry re-streams.
				gap := time.Since(lastEventAt).Round(time.Millisecond)
				utils.LogWithFields(utils.LevelError, tag, "stream idle deadline exceeded cancelling read for retry", map[string]any{
					"model": model, "request_id": requestID, "duration_ms": gap.Milliseconds(), "count": eventCount,
				})
				// provider.stall telemetry (family 4d): the upstream held the
				// stream open past the idle deadline. Pure observability; nil-safe.
				// R11: event name is carried by Event.Name; payload.kind removed.
				if sink := resolvedStreamTelemetry(); sink != nil {
					sink.Event("provider.stall", map[string]any{
						"model":            model,
						"request_id":       requestID,
						"gap_ms":           gap.Milliseconds(),
						"idle_deadline_ms": idle.Milliseconds(),
						"event_count":      eventCount,
					}, correlationCtx)
				}
				idleErr = &ProviderError{
					Code: ErrStreamTruncated,
					Message: fmt.Sprintf(
						"stream_idle: no SSE event for %s (idle deadline %s) — upstream stalled mid-stream",
						gap, idle,
					),
					Retryable: true,
				}
				return

			case <-heartbeat.C:
				// Pure observability + progress bump for a slow-but-alive
				// stream. Logged at INFO: engine.jsonl carries INFO and above,
				// and this heartbeat is the only in-file liveness signal for a
				// stream that is healthy but slow (long prefill on a huge
				// context). One line per 15s per active stream is bounded and
				// is exactly what distinguishes "slow" from "hung" during an
				// incident.
				if onProgress != nil {
					onProgress()
				}
				utils.LogWithFields(utils.LevelInfo, tag, "stream alive", map[string]any{
					"model": model, "request_id": requestID, "count": eventCount,
					"duration_ms": time.Since(start).Milliseconds(),
				})
			}
		}
	}()

	errFn := func() error {
		<-doneCh
		if idleErr != nil {
			return idleErr
		}
		// No idle timeout — defer to the underlying reader's error (clean EOF
		// → nil, transport error → that error). srcErr blocks until the source
		// goroutine finishes, which has already happened once src closed.
		return srcErr()
	}

	return out, errFn
}
