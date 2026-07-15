package backend

import (
	"fmt"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// runProgressWatchdogTickNanos is the tick interval for the run-progress
// watchdog, stored as int64 nanoseconds so tests can adjust it
// atomically without racing the long-lived watchdog goroutine that
// reads it inside time.NewTicker.
//
// 30s by default. Smaller values raise CPU overhead with no real
// benefit; larger values widen the window between stall onset and
// stall detection. 30s matches the per-tool stall-detection ticker
// (see runloop_tools.go). Production code never mutates this; tests
// set it from t.Helper-guarded setup blocks and restore via
// t.Cleanup. See runloop_watchdog_test.go.
var runProgressWatchdogTickNanos atomic.Int64

func init() {
	runProgressWatchdogTickNanos.Store(int64(30 * time.Second))
}

// runProgressWatchdogTick reads the current tick interval atomically.
// Provided for the watchdog goroutine and any test that wants to peek
// at the resolved value.
func runProgressWatchdogTick() time.Duration {
	return time.Duration(runProgressWatchdogTickNanos.Load())
}

// bumpProgressAtTurnBoundary records that the runloop just entered a
// new turn. emit() already bumps lastProgressAt on every event, but a
// turn that produces no emits before its next provider call (rare,
// but possible during compaction / hook chains that re-enter the
// runloop without surfacing intermediate state) would otherwise let
// the watchdog tick toward the threshold. The boundary bump is a
// cheap belt-and-suspenders: "we are alive and looping".
//
// Exposed as a method on *activeRun (rather than inlined in runLoop)
// to keep the watchdog's progress-tracking surface in one file. A
// future refactor that adds another progress hook (e.g. inside the
// tool dispatcher) should follow the same pattern.
func (r *activeRun) bumpProgressAtTurnBoundary() {
	r.lastProgressAt.Store(time.Now().UnixNano())
}

// Default run-stall threshold when neither the per-run TimeoutsConfig
// nor engine.json provides one. Mirrors the default returned by
// TimeoutsConfig.RunStall (10 minutes). Defined here as a named
// constant so it appears alongside the watchdog itself rather than
// being implicit in the TimeoutsConfig accessor.
const defaultRunStallThreshold = 10 * time.Minute

// runProgressWatchdog observes a single activeRun and cancels it if
// no forward progress is observed for longer than the configured
// run-stall threshold.
//
// "Forward progress" is defined as any call to ApiBackend.emit (which
// stamps run.lastProgressAt) plus explicit per-turn bumps at the top
// of runLoop's iteration. This means every provider stream chunk,
// tool result, status update, error event, and turn boundary resets
// the clock. A run that wedges inside a provider stream, a hook fire,
// a tool execution, or any other downstream subsystem stops bumping
// the clock and will be cancelled within (threshold + tick) seconds.
//
// One deliberate exception: ToolStalledEvent is emitted via
// emitWithoutProgress (not emit), so it does NOT reset the clock. That
// event is the engine signalling the *absence* of progress; counting it
// as progress would let a wedged but deadline-exempt Agent/dispatch tool
// hold the watchdog off forever by emitting a stall advisory every tick
// (the conversation 1782012033034-37d617d3d9ab incident). Conversely, a
// healthy long dispatch keeps its parent run's clock fresh through
// BumpRunProgress, which the dispatch layer calls on every genuine child
// event. See emitWithoutProgress / BumpRunProgress in api_backend.go.
//
// A second deliberate exception: a run blocked inside an intentional,
// indefinite human-wait (an elicitation awaiting a
// user decision) is exempt while the wait is open. Such a run emits no
// forward progress by design, and the human-wait is indefinite by default
// (TimeoutsConfig.HumanWait). BeginHumanWait/EndHumanWait reference-count
// the open waits on run.humanWaitDepth; while depth > 0 the watchdog skips
// its idle-cancellation check for that run, then resumes with a fresh
// window when the last wait ends. Without this exemption the watchdog
// silently overrode the indefinite-human-wait guarantee and killed runs
// parked on unanswered elicitations at the 10-minute threshold (the
// 1782060832205-836960a71da9 / 3d580dc5 incidents). This exemption is
// scoped to genuine human-waits only — a tool that wedges without a human
// in the loop is still caught.
//
// The watchdog is a safety backstop, not a performance tuner. The
// threshold should be high enough that legitimate long-running tool
// calls (e.g. lengthy bash compilations, large file reads) do not
// trip it, but low enough that an actually-wedged run does not sit
// invisibly for an entire user session. The default (10 minutes) is
// chosen to satisfy both ends. Harnesses orchestrating background
// dispatches in parallel may want to tighten this — see
// TimeoutsConfig.RunStallMs.
//
// On stall detection the watchdog:
//
//  1. Emits a RunStalledEvent (advisory; the authoritative completion
//     signal is the follow-up TaskCompleteEvent + emitExit that the
//     runLoop produces after observing ctx cancellation).
//  2. Calls run.cancel(), which propagates to the runloop's ctx,
//     unblocks the provider stream / tools / hook fires, and lets
//     runLoop reach its `if ctx.Err() != nil` branch which calls
//     emitExit cleanly. emitExit then triggers OnExit → dispatch
//     goroutine's childDone → agent_end → dispatch complete log
//     lines, restoring the observable completion invariant.
//
// The goroutine exits when the run is removed from b.activeRuns
// (runLoop's deferred removeRun) or when the run's ctx is already
// done. Either signal is sufficient — the watchdog tolerates being
// late by up to one tick.
func (b *ApiBackend) runProgressWatchdog(run *activeRun) {
	if run == nil {
		return
	}

	// Resolve the threshold once at start. Subsequent changes to the
	// engine config do not retune in-flight runs; this matches how
	// the per-tool timeout is resolved once at tool dispatch.
	threshold := defaultRunStallThreshold
	if run.cfg != nil && run.cfg.Timeouts != nil {
		threshold = run.cfg.Timeouts.RunStall()
	}
	// Defensive lower bound. A non-positive threshold (config error or
	// explicit zero) would otherwise cause the watchdog to fire on its
	// first tick. Fall back to the compiled default rather than disabling
	// the watchdog entirely — the safety backstop is more important than
	// honoring an obviously-invalid override.
	if threshold <= 0 {
		threshold = defaultRunStallThreshold
	}

	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "runProgressWatchdog: started", map[string]any{
		"run_id":    run.requestID,
		"threshold": threshold,
		"tick":      runProgressWatchdogTick(),
	})

	ticker := time.NewTicker(runProgressWatchdogTick())
	defer ticker.Stop()

	for {
		// Prefer the explicit stop signal over the ticker so the
		// watchdog tears down promptly the moment runLoop's deferred
		// removeRun closes runProgressStop. Without this branch the
		// goroutine would linger up to runProgressWatchdogTick after
		// the run completed — fine in production but a goroutine leak
		// in tests, and a real concern during process shutdown when
		// FlushConversations() expects all goroutines to drain
		// quickly. The activeRuns lookup below is the secondary
		// safety net for the (unlikely) case where the stop channel
		// was never wired.
		select {
		case <-run.progressWatchdogStop:
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "runProgressWatchdog: stop signal received, exiting", map[string]any{
				"run_id": run.requestID,
			})
			return
		case <-ticker.C:
		}

		// Is the run still active? Use the activeRuns map as the
		// source of truth — runLoop's deferred removeRun is the
		// canonical "this run ended" signal and clears the entry
		// regardless of whether the run exited normally, errored,
		// or was already cancelled.
		b.mu.Lock()
		_, stillActive := b.activeRuns[run.requestID]
		b.mu.Unlock()
		if !stillActive {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "runProgressWatchdog: run no longer active, stopping", map[string]any{
				"run_id": run.requestID,
			})
			return
		}

		lastNanos := run.lastProgressAt.Load()
		if lastNanos == 0 {
			// Should not happen — StartRunWithConfig seeds this. Treat
			// as "just started" rather than firing.
			continue
		}
		idle := time.Since(time.Unix(0, lastNanos))
		if idle < threshold {
			continue
		}

		// Human-wait exemption. A run blocked inside an intentional, indefinite
		// human-wait (an elicitation awaiting a user decision) emits no forward
		// progress by design — that is the expected state, not a stall, and the
		// human-wait is indefinite by default (see TimeoutsConfig.HumanWait).
		// BeginHumanWait/EndHumanWait reference-count these spans on
		// run.humanWaitDepth. While depth > 0 the watchdog must not cancel:
		// doing so would silently override the indefinite-human-wait guarantee
		// (the 1782060832205-836960a71da9 / 3d580dc5 incidents, where a run
		// parked on an unanswered elicitation was killed at 10m). The clock
		// resumes with a fresh window when the last human-wait ends —
		// EndHumanWait stamps lastProgressAt — so a tool that genuinely wedges
		// after a human answers is still caught on the next threshold.
		//
		// Regression tests: TestRunStallExemptDuringHumanWait (depth > 0 must
		// not cancel), TestHumanWaitDepthReferenceCounted (last-wait-wins),
		// TestEndHumanWaitResetsClock (clock refresh on depth 0), all in
		// runloop_watchdog_humanwait_test.go. Those tests go red if this branch
		// is removed.
		if run.humanWaitDepth.Load() > 0 {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "runProgressWatchdog: idle but is in a human-wait — not cancelling", map[string]any{
				"second": idle.Round(time.Second),
				"run_id": run.requestID,
				"depth":  run.humanWaitDepth.Load(),
			})
			continue
		}

		// Stall detected. Log loudly, emit the advisory event, then
		// cancel. The runLoop's `if ctx.Err() != nil` branch picks up
		// the cancellation on its next iteration and calls emitExit,
		// which fires OnExit and unwinds the dispatch goroutine in
		// the background-dispatch case.
		utils.LogWithFields(utils.LevelError, "backend.runloop", "run stalled: no progress for cancelling", map[string]any{
			"second":    idle.Round(time.Second),
			"threshold": threshold,
			"run_id":    run.requestID,
		})
		b.emit(run, types.NormalizedEvent{Data: &types.RunStalledEvent{
			StalledDuration: idle.Seconds(),
			LastActivity:    "no emit observed since last watchdog tick",
		}})
		// Also surface as a structured error so headless consumers
		// that don't subscribe to engine_run_stalled still see a
		// distinct error code in the engine_error stream.
		b.emit(run, types.NormalizedEvent{Data: &types.ErrorEvent{
			ErrorMessage: fmt.Sprintf(
				"Run stalled: no engine progress for %s. The engine has cancelled the run as a safety backstop.",
				idle.Round(time.Second),
			),
			ErrorCode: "run_stalled",
			IsError:   true,
		}})
		run.cancel()
		return
	}
}
