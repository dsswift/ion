package extension

import (
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Dispose shuts down the subprocess extension gracefully.
func (h *Host) Dispose() {
	h.disposeInternal()
}

// signalDead closes deadCh once. Idempotent. callers that added to h.pending
// after readLoop's drain already ran rely on this to unblock their select.
func (h *Host) signalDead() {
	if h.deadOnce != nil {
		h.deadOnce.Do(func() {
			if h.deadCh != nil {
				close(h.deadCh)
			}
		})
	}
}

// disposeInternal performs the shutdown. It briefly takes h.mu to mutate
// process/stdin/stdout/tempFiles fields, then releases the lock before
// waiting for the reader goroutine — the reader's defer needs h.mu to read
// h.onDeath, so holding the lock across Wait() would deadlock.
func (h *Host) disposeInternal() {
	// Mark dead so the reader goroutine stops and pending calls fail fast.
	h.dead.Store(true)
	h.signalDead()

	// Drain all pending calls with an error.
	h.pendMu.Lock()
	for id, ch := range h.pending {
		close(ch)
		delete(h.pending, id)
	}
	h.pendMu.Unlock()

	h.mu.Lock()
	if h.stdin != nil {
		_ = h.stdin.Close() //nolint:errcheck // best-effort dispose teardown
		h.stdin = nil
	}
	if h.process != nil {
		_ = h.process.Kill() //nolint:errcheck // best-effort dispose teardown
		h.process = nil
	}
	cmd := h.cmd
	h.cmd = nil
	h.stdout = nil
	exitDone := h.exitDone
	tempFiles := h.tempFiles
	h.tempFiles = nil
	h.mu.Unlock()

	if cmd != nil {
		// os/exec documents cmd.Wait as single-call: concurrent Wait calls on
		// the same Cmd are a data race. captureExitStatus owns the Wait call
		// when it is running (launched by readLoop on subprocess EOF). To avoid
		// racing with it, gate on exitDone when it is available (set during
		// spawnAndInit). exitDone is closed by captureExitStatus when Wait
		// returns, so waiting on it is equivalent to waiting for Wait — without
		// calling it a second time.
		//
		// Three cases:
		//   - exitDone non-nil, captureExitStatus running: it owns Wait; we wait
		//     for exitDone and then skip our own Wait. No race.
		//   - exitDone non-nil, captureExitStatus not running yet (process still
		//     alive; we just killed it): the kill causes EOF on stdout, readLoop
		//     will launch captureExitStatus shortly, which will reap the process
		//     and close exitDone. We wait for that.
		//   - exitDone nil (spawnAndInit never reached the exitDone init, e.g.
		//     process failed before the reader goroutine started): no
		//     captureExitStatus will ever run; call Wait directly.
		if exitDone != nil {
			select {
			case <-exitDone:
			case <-time.After(2 * time.Second):
				// Safety net: never block dispose indefinitely. If the process
				// has not been reaped in 2 s something is deeply wrong; proceed
				// so callers are not stuck. Log at ERROR so this anomalous path
				// is observable without a debugger.
				utils.LogWithFields(utils.LevelError, "extension", "disposeInternal: process reap timed out", map[string]any{
					"extension": h.name,
				})
			}
		} else {
			_ = cmd.Wait() //nolint:errcheck // best-effort dispose teardown
		}
	}
	for _, f := range tempFiles {
		_ = os.Remove(f) //nolint:errcheck // best-effort temp-file cleanup during dispose
	}

	// Wait for the reader goroutine to exit. Must be outside h.mu — the
	// reader's defer block acquires h.mu to read h.onDeath.
	h.readerWg.Wait()
}
