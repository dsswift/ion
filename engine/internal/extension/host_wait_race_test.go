package extension

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// TestHostDispose_NoRaceWithCaptureExitStatus is a regression test for the
// data race between disposeInternal and captureExitStatus when both previously
// called cmd.Wait() on the same *exec.Cmd concurrently.
//
// Race path (pre-fix):
//  1. spawnAndInit starts a subprocess that exits immediately and launches
//     readLoop.
//  2. readLoop sees EOF and spawns captureExitStatus in a goroutine, which
//     calls cmd.Wait().
//  3. The init handshake times out (no response from the dead subprocess);
//     Load's error path calls disposeInternal(), which also called cmd.Wait().
//  4. os/exec documents Wait as single-call; concurrent Wait is a data race.
//
// Fix: disposeInternal waits on exitDone (closed by captureExitStatus after
// Wait returns) instead of calling Wait itself, so exactly one goroutine ever
// calls Wait per spawn.
//
// Run under -race to verify the race detector does not fire. The test is
// repeated several times to increase the likelihood of exposing a latent race.
func TestHostDispose_NoRaceWithCaptureExitStatus(t *testing.T) {
	if _, err := os.Stat("/usr/bin/env"); err != nil {
		t.Skip("/usr/bin/env not available")
	}

	dir := t.TempDir()
	jsPath := filepath.Join(dir, "exit-immediate.js")
	if err := os.WriteFile(jsPath, []byte("process.exit(0);\n"), 0o644); err != nil {
		t.Fatalf("write extension stub: %v", err)
	}

	// Run multiple iterations to amplify the race window. Ten runs is enough
	// to catch a ~50% race without making the test slow.
	const iterations = 10
	for i := 0; i < iterations; i++ {
		h := NewHost()
		done := make(chan error, 1)
		go func() {
			done <- h.Load(jsPath, &ExtensionConfig{WorkingDirectory: dir})
		}()

		select {
		case err := <-done:
			if err == nil {
				t.Fatalf("iter %d: expected Load() to fail (subprocess exits before init)", i)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("iter %d: Load() hung — possible deadlock in disposeInternal", i)
		}
	}
}

// TestHostDispose_LiveProcessKill_NoHang covers the "dispose-first" ordering
// for the #278 fix, and pins the reap-ownership behaviour that replaced the
// original 2-second stall.
//
// In this path disposeInternal kills a live process before readLoop has
// launched captureExitStatus. Because disposeInternal sets dead=true first,
// readLoop's defer sees wasAlive=false and does NOT launch captureExitStatus —
// so nothing on the reader side will ever close exitDone.
//
// Originally dispose could only wait on exitDone here, so it burned its full
// 2 s safety-net timeout and returned WITHOUT reaping: the child was left as a
// zombie and every dispatch teardown paid two seconds. Because dispose used to
// run before the dispatch's terminal agent-state transition, that stall sat
// directly inside the window a concurrent run-exit sweep could orphan the
// dispatch's slot in.
//
// Dispose now CLAIMS the single permitted cmd.Wait (waitClaimed) when no
// reader-side capture owns it, so it reaps directly and returns promptly. The
// timeout arm remains for the genuine case where captureExitStatus owns Wait
// and is slow.
//
// The test constructs the scenario directly (within the package) rather than
// going through Load, which would block the test goroutine waiting for an init
// handshake that never arrives from a sleeping process. We start a real
// subprocess (sleep or equivalent), wire the relevant Host fields by hand, and
// call disposeInternal.
func TestHostDispose_LiveProcessKill_NoHang(t *testing.T) {
	// Use "sleep 60" as a long-lived subprocess with no stdout output.
	sleepPath, err := exec.LookPath("sleep")
	if err != nil {
		t.Skip("sleep not available in PATH")
	}

	cmd := exec.Command(sleepPath, "60")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start sleep: %v", err)
	}

	// Construct a Host with the minimal fields disposeInternal reads.
	h := NewHost()
	h.pending = make(map[int64]chan *jsonrpcResponse)
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}
	// Wire the live cmd and its process into the host exactly as spawnAndInit
	// would.
	h.cmd = cmd
	h.process = cmd.Process
	// exitDone is non-nil (set in spawnAndInit), but never closed — simulating
	// the dispose-first path where captureExitStatus never runs.
	h.exitDone = make(chan struct{})

	start := time.Now()
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.disposeInternal()
	}()

	// disposeInternal must return well inside the 2 s safety net: it kills the
	// process, wins the Wait claim (no captureExitStatus is running), and reaps
	// directly. 5 s is the outer deadlock bound.
	select {
	case <-done:
		// Pass — disposeInternal returned within the bound.
	case <-time.After(5 * time.Second):
		t.Fatal("disposeInternal did not return within 5s — possible deadlock in exitDone wait")
	}

	// Regression pin for the stall: taking the safety-net timeout here means
	// dispose is once again waiting on a channel nobody will close, which is
	// what put a fixed 2 s gap between a child finishing and its dispatch slot
	// being marked terminal. Reverting the waitClaimed ownership makes this
	// elapsed time jump to ~2 s and turns this assertion red.
	if elapsed := time.Since(start); elapsed >= 2*time.Second {
		t.Errorf("disposeInternal took %v; expected a direct reap well under the 2s safety net "+
			"(dispose must claim cmd.Wait when no captureExitStatus owns it)", elapsed)
	}

	// Dispose owned the reap, so the process is already collected. A second
	// Wait must therefore fail — proving dispose actually reaped rather than
	// timing out and leaving a zombie behind.
	if err := cmd.Wait(); err == nil {
		t.Error("cmd.Wait() succeeded after dispose; dispose did not reap the process itself")
	}
}
