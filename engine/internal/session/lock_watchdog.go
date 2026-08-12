// Session-lock stall detection.
//
// The Manager's mutex serialises every session lifecycle operation, so a
// goroutine that holds it indefinitely takes the whole engine with it: the
// socket keeps accepting commands, each dispatch arm blocks on the lock, and
// the only thing that reaches the log is whatever each arm printed *before*
// acquiring. That failure has happened — start_session was queued behind a
// single holder for 3h44m while the log showed nothing but the pre-lock
// "startsession" line, repeated 409 times as the desktop retried. Nothing in
// the engine noticed, and with no pprof endpoint there was no way to ask the
// running daemon who the holder was.
//
// The watchdog closes that blind spot. It probes the lock on a fixed cadence;
// when a probe cannot acquire within the threshold, it writes a full goroutine
// dump to disk and logs an ERROR naming the file. The dump is what identifies
// the holder, so the next occurrence is diagnosable from the artifacts alone.
//
// Detection only. The watchdog never cancels, unlocks, or otherwise touches
// the holder — an engine that force-releases a mutex it does not own corrupts
// the state the lock was protecting.
package session

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultLockProbeInterval is how often the watchdog probes the lock.
const DefaultLockProbeInterval = 15 * time.Second

// DefaultLockStallThreshold is how long a probe may wait before the hold is
// reported. Legitimate holds are sub-millisecond — every locked region in the
// Manager is a map operation or a field assignment — so a wait this long means
// a holder is blocked on something it should not be doing under the lock.
const DefaultLockStallThreshold = 30 * time.Second

// lockWatchdog reports mutex holds that outlast a threshold. Constructed with
// a probe closure rather than a mutex so the guarded lock stays private to its
// owner and tests can drive it without a Manager.
type lockWatchdog struct {
	name      string
	probe     func() // acquires and immediately releases the guarded lock
	interval  time.Duration
	threshold time.Duration

	// onStall replaces the default report. Tests set it; production leaves it
	// nil and gets the dump-to-disk + ERROR log path.
	onStall func(name string, waited time.Duration, dump []byte)

	stopCh    chan struct{}
	stopOnce  sync.Once
	doneCh    chan struct{}
	startOnce sync.Once
}

func newLockWatchdog(name string, probe func()) *lockWatchdog {
	return &lockWatchdog{
		name:      name,
		probe:     probe,
		interval:  DefaultLockProbeInterval,
		threshold: DefaultLockStallThreshold,
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}
}

// start launches the probe loop. Idempotent.
func (w *lockWatchdog) start() {
	w.startOnce.Do(func() {
		utils.LogWithFields(utils.LevelInfo, "session.lockwatch", "lock watchdog started", map[string]any{
			"reason": w.name, "duration_ms": w.interval.Milliseconds(), "max": w.threshold.Milliseconds(),
		})
		go w.run()
	})
}

// stop ends the probe loop and waits for it to exit. Idempotent, and safe to
// call on a watchdog that was never started.
func (w *lockWatchdog) stop() {
	w.stopOnce.Do(func() { close(w.stopCh) })
	// Claiming startOnce here proves start() never did, which means run() was
	// never launched and nothing will ever close doneCh.
	neverStarted := false
	w.startOnce.Do(func() { neverStarted = true })
	if neverStarted {
		return
	}
	<-w.doneCh
}

func (w *lockWatchdog) run() {
	defer close(w.doneCh)
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		select {
		case <-w.stopCh:
			return
		case <-ticker.C:
			w.probeOnce()
		}
	}
}

// probeOnce acquires the lock in a helper goroutine and reports if that takes
// longer than the threshold. It keeps waiting after reporting so exactly one
// probe is ever outstanding — a second probe piling onto a lock that is
// already known to be stuck adds a blocked goroutine and no information — and
// so the recovery is logged with the hold's true total duration.
func (w *lockWatchdog) probeOnce() {
	acquired := make(chan struct{})
	go func() {
		w.probe()
		close(acquired)
	}()

	started := time.Now()
	select {
	case <-acquired:
		return // healthy: the common path logs nothing.
	case <-time.After(w.threshold):
	}

	waited := time.Since(started)
	w.report(waited)

	select {
	case <-acquired:
		utils.LogWithFields(utils.LevelWarn, "session.lockwatch", "lock released after stall", map[string]any{
			"reason": w.name, "duration_ms": time.Since(started).Milliseconds(),
		})
	case <-w.stopCh:
		utils.LogWithFields(utils.LevelError, "session.lockwatch", "lock still held at shutdown", map[string]any{
			"reason": w.name, "duration_ms": time.Since(started).Milliseconds(),
		})
	}
}

// report captures every goroutine's stack and hands it to onStall, or to the
// default dump-and-log path.
func (w *lockWatchdog) report(waited time.Duration) {
	dump := goroutineDump()
	if w.onStall != nil {
		w.onStall(w.name, waited, dump)
		return
	}
	path, err := writeStallDump(w.name, dump)
	fields := map[string]any{"reason": w.name, "duration_ms": waited.Milliseconds(), "count": runtime.NumGoroutine()}
	if err != nil {
		// The dump is the whole diagnostic, so a failed write is itself
		// reportable — and the head of the dump still names the holder.
		fields["error"] = err.Error()
		fields["string"] = string(dump[:min(len(dump), 4096)])
	} else {
		fields["path"] = path
	}
	utils.LogWithFields(utils.LevelError, "session.lockwatch", "lock held past stall threshold; goroutine dump captured", fields)
}

// goroutineDump returns the stacks of all goroutines, growing the buffer until
// the dump fits (runtime.Stack truncates rather than reporting the need).
func goroutineDump() []byte {
	size := 1 << 20
	for {
		buf := make([]byte, size)
		n := runtime.Stack(buf, true)
		if n < size {
			return buf[:n]
		}
		if size >= 64<<20 {
			return buf[:n] // pathological goroutine count; take the truncation.
		}
		size *= 2
	}
}

// writeStallDump persists a dump under ~/.ion/diagnostics and returns its path.
// Kept out of the JSONL log because a dump runs to megabytes and would push
// every other line out of the rotation window.
func writeStallDump(name string, dump []byte) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home: %w", err)
	}
	dir := filepath.Join(home, ".ion", "diagnostics")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	path := filepath.Join(dir, fmt.Sprintf("lock-stall-%s-%s.txt", name, time.Now().UTC().Format("20060102T150405Z")))
	if err := os.WriteFile(path, dump, 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", path, err)
	}
	return path, nil
}
