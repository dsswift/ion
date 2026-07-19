package extension

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestHostLoad_StderrTailPopulatedAfterInitFailure is a regression test for
// issue #201 (Gap 1 + Gap 3): the stderr-drain goroutine must be fully done
// before Load returns on the init-failure path, so callers that immediately
// read StderrTail after the error see a populated ring buffer.
//
// Pre-fix: launchStderrDrain launched an untracked goroutine; Load returned the
// init-handshake error before the goroutine finished draining stderr, so callers
// that called StderrTail right after Load returned an empty slice.
//
// Fix: launchStderrDrain adds 1 to stderrDrainWg before launching. Load calls
// disposeInternal (which kills the subprocess and closes the stderr pipe) and
// then WaitStderrDrain (which blocks until the drain goroutine sees EOF and
// calls Done). WaitStderrDrain MUST run after disposeInternal — calling it
// inside spawnAndInit while h.mu is held would deadlock when the subprocess is
// still alive (hookError path: disposeInternal can't run while h.mu is held).
func TestHostLoad_StderrTailPopulatedAfterInitFailure(t *testing.T) {
	t.Parallel()

	// Write a small extension script that emits several lines to stderr and
	// immediately exits non-zero, so the init handshake never succeeds.
	dir := t.TempDir()
	script := filepath.Join(dir, "index.js")
	// Write lines to stderr, then exit — the init response never comes.
	content := `process.stderr.write("diagnostic line 1\n");
process.stderr.write("diagnostic line 2\n");
process.stderr.write("diagnostic line 3\n");
process.exit(1);
`
	if err := os.WriteFile(script, []byte(content), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}

	h := NewHost()
	err := h.Load(script, nil)
	if err == nil {
		t.Fatal("expected Load to return an error for a subprocess that exits immediately")
	}

	// StderrTail must be fully populated: all 3 lines should be present.
	// Before the fix this returned an empty slice because the drain goroutine
	// was still running when Load returned.
	tail := h.StderrTail()
	joined := strings.Join(tail, "\n")

	for _, want := range []string{"diagnostic line 1", "diagnostic line 2", "diagnostic line 3"} {
		if !strings.Contains(joined, want) {
			t.Errorf("StderrTail missing %q after init failure; got: %v", want, tail)
		}
	}
}

// TestHostLoad_StderrTailPopulatedAfterHookError is a regression test for the
// deadlock that would occur if WaitStderrDrain were called inside spawnAndInit
// (under h.mu) when the subprocess is still alive.
//
// The hookError path: the subprocess writes stderr lines and then sends a valid
// JSON-RPC error response to the init call (non-zero "error" field), then stays
// alive. h.call("init", ...) returns a hookError. If WaitStderrDrain were called
// inside spawnAndInit at this point, it would block forever — the drain goroutine
// can't exit because the subprocess is still alive and holding its stderr pipe
// open; disposeInternal (which kills the subprocess) can't run because Load
// holds h.mu and spawnAndInit hasn't returned yet. Classic deadlock.
//
// The fix moves WaitStderrDrain to Load's error path after disposeInternal, so
// the sequence is: disposeInternal kills the process → pipe closes → drain exits
// → WaitStderrDrain returns → StderrTail is populated.
//
// This test verifies:
// - Load returns an error (init hookError).
// - StderrTail is populated with the lines the subprocess wrote.
// - The test completes without deadlocking (a 10s timeout would fire otherwise).
func TestHostLoad_StderrTailPopulatedAfterHookError(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	script := filepath.Join(dir, "index.js")

	// Build a valid JSON-RPC 2.0 error response for the init call.
	// The engine sends {"jsonrpc":"2.0","method":"init","params":...,"id":1};
	// we reply with an error. The subprocess then loops forever so the stderr
	// pipe stays open — this is what triggers the deadlock in the unfixed code.

	// The script must read the init request to get its ID before replying.
	// We use readline to consume one line from stdin (the init request), parse
	// the id, then send the error response with the matching id, then block.
	scriptContent := `
const readline = require('readline');
process.stderr.write("hook error line A\n");
process.stderr.write("hook error line B\n");

const rl = readline.createInterface({ input: process.stdin });
rl.once('line', (line) => {
  let id = 1;
  try { id = JSON.parse(line).id; } catch(_) {}
  const resp = JSON.stringify({jsonrpc:"2.0",id,error:{code:-32000,message:"intentional init error"}});
  process.stdout.write(resp + "\n");
  // Stay alive so the stderr pipe stays open — this exercises the deadlock path.
  setInterval(() => {}, 1e9);
});
`

	if err := os.WriteFile(script, []byte(scriptContent), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}

	h := NewHost()
	loadErr := h.Load(script, nil)
	if loadErr == nil {
		t.Fatal("expected Load to return an error for a subprocess that sends a hookError from init")
	}

	// StderrTail must contain the lines written before the error response.
	// Before the fix (WaitStderrDrain inside spawnAndInit under h.mu), this
	// test would hang until the test timeout fires — the deadlock is the bug.
	tail := h.StderrTail()
	joined := strings.Join(tail, "\n")

	for _, want := range []string{"hook error line A", "hook error line B"} {
		if !strings.Contains(joined, want) {
			t.Errorf("StderrTail missing %q after hookError; got: %v", want, tail)
		}
	}
}
