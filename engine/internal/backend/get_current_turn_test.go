package backend

import (
	"testing"
)

// TestGetCurrentTurnReturnsLiveTurn pins the accessor the session layer uses to
// wire Context.GetTurn for hook_latency attribution. It must return the active
// run's live turn counter.
func TestGetCurrentTurnReturnsLiveTurn(t *testing.T) {
	b := NewApiBackend()
	const requestID = "req-turn"

	run := &activeRun{requestID: requestID}
	run.turnCount.Store(7)
	b.mu.Lock()
	b.activeRuns[requestID] = run
	b.mu.Unlock()

	if got := b.GetCurrentTurn(requestID); got != 7 {
		t.Errorf("GetCurrentTurn = %d, want 7", got)
	}

	// A later turn advance is reflected live.
	run.turnCount.Store(12)
	if got := b.GetCurrentTurn(requestID); got != 12 {
		t.Errorf("GetCurrentTurn after advance = %d, want 12", got)
	}
}

// TestGetCurrentTurnUnknownRunReturnsZero verifies the accessor is safe for a
// requestID with no active run (non-run hook fires, or the run already exited).
// It must return 0, not panic.
func TestGetCurrentTurnUnknownRunReturnsZero(t *testing.T) {
	b := NewApiBackend()

	if got := b.GetCurrentTurn("no-such-run"); got != 0 {
		t.Errorf("GetCurrentTurn(unknown) = %d, want 0", got)
	}
}
