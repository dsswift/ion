package backend

import (
	"context"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// This file pins the ordering guarantee between a run's exit notification
// and its removal from activeRuns: emitExit (api_backend.go) now removes the
// run before invoking the registered OnExit listener, so IsRunning(id) is
// always false by the time any exit observer runs. Before that fix, the two
// were separate, non-atomic steps and an observer could catch the run still
// marked active -- flaky enough to reproduce reliably only under contention
// (observed on Windows CI and, previously, the macOS CI runner), which is
// why the tests below no longer poll for the transition.

func TestCancelWatchdogForcesExitWhenRunGoroutineWedges(t *testing.T) {
	b := NewApiBackend()

	// Manually populate activeRuns to simulate a wedged run with no real
	// goroutine. Cancel will call run.cancel() (no-op since context is not
	// observed by anyone), then the watchdog should still fire.
	_, cancelFn := context.WithCancel(context.Background())
	wedged := &activeRun{
		requestID: "req-wedged",
		cancel:    cancelFn,
		startTime: time.Now(),
		// conv intentionally nil — exercises the "no session ID" branch
		// of cancelWatchdog.
	}
	b.mu.Lock()
	b.activeRuns["req-wedged"] = wedged
	b.mu.Unlock()

	c := collectEvents(b, "req-wedged")

	if !b.Cancel("req-wedged") {
		t.Fatal("Cancel returned false for active run")
	}

	// Watchdog grace is 5s; allow generous slack.
	if !waitForExit(c, 7*time.Second) {
		t.Fatal("Cancel watchdog did not force exit within grace period")
	}

	// Verify the synthetic signal so future audits can grep for forced exits.
	c.mu.Lock()
	gotSignal := ""
	if c.exitSignal != nil {
		gotSignal = *c.exitSignal
	}
	c.mu.Unlock()
	if gotSignal != "cancelled-forced" {
		t.Errorf("expected exit signal %q, got %q", "cancelled-forced", gotSignal)
	}

	// activeRuns must be empty immediately after the exit callback fires:
	// emitExit removes the run before notifying the OnExit listener (see
	// emitExit in api_backend.go), so cancelWatchdog's own explicit removeRun
	// call became redundant and was removed.
	b.mu.Lock()
	_, stillThere := b.activeRuns["req-wedged"]
	b.mu.Unlock()
	if stillThere {
		t.Fatal("watchdog left run in activeRuns immediately after the exit callback fired")
	}
}

func TestIsRunningDuringAndAfter(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("quick", 10, 5),
	})

	b := NewApiBackend()
	c := collectEvents(b, "req-running")
	b.StartRun("req-running", types.RunOptions{
		Prompt:           "test",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	if !waitForExit(c, 5*time.Second) {
		t.Fatal("timed out")
	}

	if b.IsRunning("req-running") {
		t.Fatal("expected IsRunning false immediately after the exit callback fired")
	}
}

// TestIsRunningFalseInsideExitCallback pins the ordering guarantee
// deterministically, independent of goroutine scheduling: an OnExit listener
// observing the exit must already see IsRunning() == false *from inside its
// own callback*, not merely by the time some later statement runs. Checking
// only after waitForExit returns (as TestIsRunningDuringAndAfter does) relies
// on real scheduling and only reproduced the bug under contention; checking
// from inside the callback reproduces it on every run, on every platform,
// because it does not depend on how long it takes the test goroutine to
// notice the exit.
func TestIsRunningFalseInsideExitCallback(t *testing.T) {
	setupTestProvider([][]types.LlmStreamEvent{
		textResponse("quick", 10, 5),
	})

	b := NewApiBackend()
	requestID := "req-inside-callback"

	stillRunning := make(chan bool, 1)
	b.OnExit(func(runID string, _ *int, _ *string, _ string) {
		if runID == requestID {
			stillRunning <- b.IsRunning(runID)
		}
	})

	b.StartRun(requestID, types.RunOptions{
		Prompt:           "test",
		ProjectPath:      "/tmp",
		Model:            testModel,
		EarlyStopEnabled: testEarlyStopDisabled(),
	})

	select {
	case got := <-stillRunning:
		if got {
			t.Fatal("expected IsRunning false from inside the OnExit callback")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for exit callback")
	}
}
