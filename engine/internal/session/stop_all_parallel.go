package session

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// stopAllConcurrency bounds how many sessions are torn down at once by
// stopAllSessions.
//
// Teardown is not CPU work: the expensive part of StopSession happens in
// finishStoppedSession, AFTER Manager.mu is released, and it is almost entirely
// waiting — firing `session_end` into each extension host over RPC (bounded by
// the hook timeout, which is 30s by default), closing MCP connections, killing
// host process groups, flushing telemetry. Serially, the daemon's total
// shutdown is the SUM of those waits across every live session; in parallel it
// is roughly the slowest one per batch.
//
// A bound rather than an unbounded fan-out because each teardown kills process
// groups and closes sockets: releasing several hundred at once on a host that
// is already shutting down trades one pathology for another. 8 keeps a
// many-session daemon's teardown flat without a thundering herd.
const stopAllConcurrency = 8

// stopAllSessions stops every session in keys, at most stopAllConcurrency at a
// time, and returns when all of them have been stopped.
//
// Extracted from Manager.StopAll (manager.go is allowlisted at its size cap and
// must not grow) and shared with it. The serial loop this replaces is why a
// graceful shutdown could overrun its supervisor's exit timeout: with ~35 live
// sessions each firing session_end hooks into extension hosts, teardown ran
// past 4.5 seconds against a 5-second launchd exit timeout, so the daemon was
// SIGKILLed partway through, exited non-zero, and was respawned by KeepAlive —
// repeatedly.
//
// Ordering: StopSession takes Manager.mu for its map-mutating prologue, so the
// per-session state transitions still serialize on that lock and keep their
// existing semantics. Only the post-lock resource teardown overlaps, and that
// operates exclusively on resources captured per session.
func (m *Manager) stopAllSessions(keys []string) {
	if len(keys) == 0 {
		utils.LogWithFields(utils.LevelInfo, "session", "stopallsessions: no live sessions to stop", map[string]any{"count": 0})
		return
	}

	workers := stopAllConcurrency
	if len(keys) < workers {
		workers = len(keys)
	}
	started := time.Now()
	utils.LogWithFields(utils.LevelInfo, "session", "stopallsessions: starting", map[string]any{
		"count": len(keys), "workers": workers,
	})

	work := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := range work {
				m.StopSession(k) //nolint:errcheck // best-effort stop; not-found is benign
			}
		}()
	}
	for _, k := range keys {
		work <- k
	}
	close(work)
	wg.Wait()

	utils.LogWithFields(utils.LevelInfo, "session", "stopallsessions: finished", map[string]any{
		"count": len(keys), "workers": workers, "duration_ms": time.Since(started).Milliseconds(),
	})
}
