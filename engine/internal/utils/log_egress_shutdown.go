// log_egress_shutdown.go — bounded final drain of log egress at process exit.
package utils

import (
	"sync"
	"time"
)

var (
	activeTailerMu sync.Mutex
	// activeTailer is the most recently started egress tailer. Tracked so the
	// shutdown drain can stop it before closing the forwarder it feeds.
	activeTailer *EgressTailer
)

// registerEgressTailer records t as the tailer ShutdownLogEgress stops. A
// previously registered tailer is stopped: only one tailer feeds the active
// forwarder at a time.
func registerEgressTailer(t *EgressTailer) {
	activeTailerMu.Lock()
	prev := activeTailer
	activeTailer = t
	activeTailerMu.Unlock()
	if prev != nil && prev != t {
		prev.Stop()
	}
}

// ShutdownLogEgress performs the final egress drain before the process exits.
// It stops the file tailer first, so the lines it reads on its last poll enter
// the forwarder's buffer, then detaches and closes the forwarder, which
// exports its buffer and attempts one spool drain. Records that cannot be
// delivered stay in the on-disk spool for the next start.
//
// The drain is bounded by timeout: a sink that hangs cannot hold the process
// open. Returns true when the drain finished within the budget (or there was
// nothing to drain). Log lines written after this call reach only the local
// file, so call it after the process's final log lines.
func ShutdownLogEgress(timeout time.Duration) bool {
	activeTailerMu.Lock()
	tailer := activeTailer
	activeTailer = nil
	activeTailerMu.Unlock()

	logMu.Lock()
	fwd := activeEgressForwarder
	logMu.Unlock()

	if tailer == nil && fwd == nil {
		return true
	}

	// Logged before the forwarder detaches so this line ships with the rest.
	LogWithFields(LevelInfo, "log_egress", "log egress shutdown drain starting", map[string]any{
		"tailer": tailer != nil, "forwarder": fwd != nil, "timeout_ms": timeout.Milliseconds(),
	})

	started := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		tailer.Stop()
		// Detach under logMu so no later log line enters a closing buffer,
		// then close outside the lock: Close's final flush can log an error,
		// and logging re-acquires logMu.
		logMu.Lock()
		if activeEgressForwarder == fwd {
			activeEgressForwarder = nil
		}
		logMu.Unlock()
		fwd.Close()
	}()

	select {
	case <-done:
		LogWithFields(LevelInfo, "log_egress", "log egress shutdown drain finished", map[string]any{
			"duration_ms": time.Since(started).Milliseconds(),
		})
		return true
	case <-time.After(timeout):
		LogWithFields(LevelWarn, "log_egress", "log egress shutdown drain timed out; undelivered records remain buffered or spooled", map[string]any{
			"timeout_ms": timeout.Milliseconds(),
		})
		return false
	}
}
