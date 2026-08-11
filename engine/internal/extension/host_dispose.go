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
	// Captured before the kill so the reap diagnostics below can name the
	// process even though h.process is cleared here.
	pid := 0
	if h.process != nil {
		pid = h.process.Pid
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
		// the same Cmd are a data race. Ownership is settled by the waitClaimed
		// CAS rather than by guessing which path got there first.
		//
		// Three cases:
		//   - We win the claim: readLoop never launched captureExitStatus (no
		//     EOF observed, which is the common case when dispose is what kills
		//     the process). We must do the Wait ourselves — before this claim
		//     existed, nobody did, so exitDone was never closed and dispose sat
		//     out its full 2s timeout on every teardown while leaving the
		//     process unreaped.
		//   - captureExitStatus won the claim: it owns Wait and closes exitDone
		//     when it returns. We wait on exitDone, capped, and never call Wait.
		//   - exitDone is nil (spawnAndInit never got that far, e.g. the process
		//     failed before the reader goroutine started): no captureExitStatus
		//     will ever run, so Wait directly.
		if exitDone == nil {
			if h.waitClaimed.CompareAndSwap(false, true) {
				_ = cmd.Wait() //nolint:errcheck // best-effort dispose teardown
			}
		} else if h.waitClaimed.CompareAndSwap(false, true) {
			// We own the reap. Wait is bounded by the process already having
			// been killed above, so this does not need the safety-net timeout.
			_ = cmd.Wait() //nolint:errcheck // best-effort dispose teardown
			utils.LogWithFields(utils.LevelDebug, "extension", "disposeInternal: reaped subprocess directly (no reader-side capture was running)", map[string]any{
				"extension": h.name,
			})
		} else {
			select {
			case <-exitDone:
			case <-time.After(2 * time.Second):
				// Safety net: never block dispose indefinitely. captureExitStatus
				// owns the Wait but has not finished in 2 s. Log the state that
				// distinguishes a genuinely slow reap from a wedged reader so the
				// branch is diagnosable from logs alone.
				utils.LogWithFields(utils.LevelError, "extension", "disposeInternal: process reap timed out (captureExitStatus owns Wait and has not returned)", map[string]any{
					"extension": h.name,
					"pid":       pid,
					"dead":      h.dead.Load(),
				})
			}
		}
	}
	for _, f := range tempFiles {
		_ = os.Remove(f) //nolint:errcheck // best-effort temp-file cleanup during dispose
	}

	// Wait for the reader goroutine to exit. Must be outside h.mu — the
	// reader's defer block acquires h.mu to read h.onDeath.
	h.readerWg.Wait()
}
