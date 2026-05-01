package extension

import (
	"os"
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
		h.stdin.Close()
		h.stdin = nil
	}
	if h.process != nil {
		h.process.Kill()
		h.process = nil
	}
	cmd := h.cmd
	h.cmd = nil
	h.stdout = nil
	tempFiles := h.tempFiles
	h.tempFiles = nil
	h.mu.Unlock()

	if cmd != nil {
		cmd.Wait()
	}
	for _, f := range tempFiles {
		os.Remove(f)
	}

	// Wait for the reader goroutine to exit. Must be outside h.mu — the
	// reader's defer block acquires h.mu to read h.onDeath.
	h.readerWg.Wait()
}
