package extension

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestHostDispose_NoRaceWithCaptureExitStatus is a regression test for the
// data race between disposeInternal and captureExitStatus when both previously
// called cmd.Wait() on the same *exec.Cmd concurrently.
//
// Race path (pre-fix):
//   1. spawnAndInit starts a subprocess that exits immediately and launches
//      readLoop.
//   2. readLoop sees EOF and spawns captureExitStatus in a goroutine, which
//      calls cmd.Wait().
//   3. The init handshake times out (no response from the dead subprocess);
//      Load's error path calls disposeInternal(), which also called cmd.Wait().
//   4. os/exec documents Wait as single-call; concurrent Wait is a data race.
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
