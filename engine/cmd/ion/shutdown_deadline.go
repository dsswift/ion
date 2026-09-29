package main

import (
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Fixed budgets for the steps serve runs after session teardown. With the
// default Shutdown budget the whole graceful shutdown stays inside the shipped
// LaunchAgent's ExitTimeOut window, so the supervisor's kill stays a backstop.
const (
	// metricsExportShutdownTimeout bounds the final OTLP metrics export.
	metricsExportShutdownTimeout = 5 * time.Second
	// logEgressShutdownTimeout bounds the final log egress drain.
	logEgressShutdownTimeout = 5 * time.Second
)

// serveShutdownBudget is the longest a graceful serve shutdown runs once it
// starts: the session teardown budget plus the fixed post-teardown steps. A
// parent that asked serve to shut down waits this long for it to exit.
func serveShutdownBudget(timeouts *types.TimeoutsConfig) time.Duration {
	return timeouts.Shutdown() + metricsExportShutdownTimeout + logEgressShutdownTimeout
}

// serverStopper is the slice of *server.Server that stopServerBounded needs.
// An interface rather than the concrete type so the deadline behavior is
// testable without standing up a listener, sessions, and extension hosts.
type serverStopper interface {
	Stop() error
}

// stopServerBounded runs srv.Stop() with a deadline and reports whether
// teardown completed within it.
//
// The engine runs under a supervisor that kills it if graceful shutdown
// overruns a grace window — launchd reports `exit timeout` for the job and
// SIGKILLs at that mark. Losing that race is worse than giving up on teardown:
// the process exits non-zero, which the supervisor cannot distinguish from a
// crash, so `KeepAlive.SuccessfulExit=false` respawns it. On a daemon whose
// teardown reliably overruns, that is a restart loop — observed in production
// as ~60-second engine lifetimes, because ~35 live sessions firing session_end
// hooks took longer to tear down than the 5 seconds launchd allowed.
//
// So the engine bounds its own shutdown and always exits under its own control.
// Work that must survive a shutdown does not depend on this path: conversation
// durability is already flushed before Stop is called, and per-event saves in
// the agent loop cover an outright SIGKILL.
//
// Abandoning teardown is not silent. Stop keeps running on its goroutine (it is
// sync.Once-guarded and safe to leave in flight while the process exits), and
// the overrun is logged at ERROR with the budget so the operator sees exactly
// which shutdowns are not completing — the blind spot that let the restart loop
// read as a clean exit for hours.
func stopServerBounded(srv serverStopper, budget time.Duration) bool {
	started := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if err := srv.Stop(); err != nil {
			utils.LogWithFields(utils.LevelError, "main", "server stop failed during shutdown", map[string]any{"error": utils.ErrStr(err)})
		}
	}()

	select {
	case <-done:
		utils.LogWithFields(utils.LevelInfo, "main", "graceful teardown completed within budget", map[string]any{
			"duration_ms": time.Since(started).Milliseconds(), "budget_ms": budget.Milliseconds(),
		})
		return true
	case <-time.After(budget):
		utils.LogWithFields(utils.LevelError, "main", "graceful teardown exceeded its budget; exiting without waiting for it", map[string]any{
			"budget_ms": budget.Milliseconds(),
			"detail":    "sessions may not have fired session_end; conversations were already flushed before teardown began",
		})
		return false
	}
}
