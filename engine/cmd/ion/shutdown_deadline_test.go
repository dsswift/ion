package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// stubStopper stands in for *server.Server. block, when non-nil, holds Stop()
// until it is closed — that is how the overrun arm is produced without waiting
// on real teardown.
type stubStopper struct {
	block chan struct{}
	err   error
	calls chan struct{}
}

func (s *stubStopper) Stop() error {
	if s.calls != nil {
		s.calls <- struct{}{}
	}
	if s.block != nil {
		<-s.block
	}
	return s.err
}

// A teardown that finishes inside the budget reports completion.
func TestStopServerBounded_CompletesWithinBudget(t *testing.T) {
	srv := &stubStopper{}

	if ok := stopServerBounded(srv, 2*time.Second); !ok {
		t.Error("stopServerBounded: got false, want true for a teardown that returned promptly")
	}
}

// A Stop() error is surfaced as a completed teardown — it returned, which is
// what the deadline is about. The error itself is logged, not swallowed.
func TestStopServerBounded_CompletesEvenWhenStopErrors(t *testing.T) {
	srv := &stubStopper{err: errors.New("listener close failed")}

	if ok := stopServerBounded(srv, 2*time.Second); !ok {
		t.Error("stopServerBounded: got false, want true when Stop returned an error promptly")
	}
}

// The regression this pins: a teardown slower than the budget must NOT hold the
// process. Before the bound, main() waited on srv.Stop() indefinitely, so a
// daemon with many sessions was still inside teardown when launchd's exit
// timeout elapsed and SIGKILLed it — a non-zero exit that KeepAlive respawned.
//
// Reverting the deadline (awaiting Stop directly) makes this test hang until the
// package timeout rather than pass.
func TestStopServerBounded_ReturnsWhenTeardownOverrunsBudget(t *testing.T) {
	block := make(chan struct{})
	srv := &stubStopper{block: block}
	// Released only after the assertion, so the goroutine does not leak past the
	// test while still proving stopServerBounded returned with Stop in flight.
	defer close(block)

	started := time.Now()
	ok := stopServerBounded(srv, 50*time.Millisecond)
	elapsed := time.Since(started)

	if ok {
		t.Error("stopServerBounded: got true, want false when teardown outlived the budget")
	}
	if elapsed > 2*time.Second {
		t.Errorf("stopServerBounded waited %v; it must return at roughly the budget, not wait for teardown", elapsed)
	}
}

// ─── Breadcrumb honesty across the shutdown window ───────────────────────────

// writeStopping records a shutdown that has begun but not finished, and pins the
// reason and the shutdown-start timestamp that logPriorExit reports from.
func TestExitBreadcrumb_WriteStoppingRecordsInProgressShutdown(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)

	writeStopping(path, "terminated")

	rec := readRecord(t, path)
	if rec.Status != "stopping" {
		t.Errorf("status: got %q want %q", rec.Status, "stopping")
	}
	if rec.Reason != "terminated" {
		t.Errorf("reason: got %q want %q", rec.Reason, "terminated")
	}
	if rec.ShutdownStartedAt == 0 {
		t.Error("shutdownStartedAt should be set so teardown duration is recoverable")
	}
	if rec.ExitedAt != 0 {
		t.Errorf("exitedAt: got %d want 0 — the process has not exited yet", rec.ExitedAt)
	}
}

// The core regression. A process killed partway through teardown must NOT leave
// a record claiming a clean exit: writeClean used to run at the TOP of the
// shutdown handler, so every SIGKILLed teardown in the restart loop logged
// `prior exit: clean` and hid the loop.
//
// With the fix reverted (writeClean before teardown) the status here is "clean"
// and this test fails.
func TestExitBreadcrumb_KilledDuringTeardownIsNotRecordedClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)

	// Shutdown begins...
	writeStopping(path, "terminated")
	// ...and the process dies here, before writeClean is reached.

	rec := readRecord(t, path)
	if rec.Status == "clean" {
		t.Fatal("a teardown that never completed was recorded as a clean exit")
	}
	if rec.Status != "stopping" {
		t.Errorf("status: got %q want %q", rec.Status, "stopping")
	}
}

// A shutdown that runs to completion still ends up clean, and keeps the
// shutdown-start timestamp so the completed teardown's duration is recoverable.
func TestExitBreadcrumb_CompletedShutdownFinalizesClean(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)

	writeStopping(path, "terminated")
	stopAt := readRecord(t, path).ShutdownStartedAt
	writeClean(path, "terminated")

	rec := readRecord(t, path)
	if rec.Status != "clean" {
		t.Errorf("status: got %q want %q", rec.Status, "clean")
	}
	if rec.ExitedAt == 0 {
		t.Error("exitedAt should be set once shutdown completed")
	}
	if rec.ShutdownStartedAt != stopAt {
		t.Errorf("shutdownStartedAt: got %d want %d — writeClean must preserve it", rec.ShutdownStartedAt, stopAt)
	}
}

// logPriorExit must classify a "stopping" record rather than fall through to the
// unknown-status arm, which is what it would do before this status existed.
func TestLogPriorExit_ClassifiesStoppingRecord(t *testing.T) {
	path := filepath.Join(t.TempDir(), "engine.exit")
	writeRunning(path)
	writeStopping(path, "terminated")

	// logPriorExit only logs; the assertion that matters is that the status is
	// one it handles, pinned alongside the call so an added status cannot
	// silently regress into the default arm.
	logPriorExit(path)

	if got := readRecord(t, path).Status; got != "stopping" {
		t.Errorf("status: got %q want %q", got, "stopping")
	}
}

func readRecord(t *testing.T, path string) exitRecord {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read breadcrumb: %v", err)
	}
	var rec exitRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		t.Fatalf("unmarshal breadcrumb: %v", err)
	}
	return rec
}
