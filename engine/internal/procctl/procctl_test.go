package procctl_test

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/procctl"
)

// sleeperBin is the path to the compiled testdata/sleeper helper, built once
// in TestMain.
var sleeperBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "procctl-test-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)

	bin := filepath.Join(dir, "sleeper")
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	build := exec.Command("go", "build", "-o", bin, "./testdata/sleeper")
	build.Dir = "."
	if out, err := build.CombinedOutput(); err != nil {
		panic("building sleeper helper: " + err.Error() + "\n" + string(out))
	}
	sleeperBin = bin

	os.Exit(m.Run())
}

// TestKillTree_EndsGrandchild spawns the sleeper helper, which spawns its own
// child, and asserts KillTree ends both the parent and the grandchild.
func TestKillTree_EndsGrandchild(t *testing.T) {
	cmd := exec.Command(sleeperBin)
	procctl.Configure(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := procctl.AfterStart(cmd); err != nil {
		t.Logf("AfterStart returned an error (degrades to direct-child kill): %v", err)
	}
	t.Cleanup(func() { procctl.Release(cmd) })

	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() {
		t.Fatalf("did not read child pid from sleeper stdout: %v", scanner.Err())
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(scanner.Text()))
	if err != nil {
		t.Fatalf("parse child pid %q: %v", scanner.Text(), err)
	}
	parentPID := cmd.Process.Pid

	if !procctl.Alive(parentPID) {
		t.Fatalf("parent %d should be alive before KillTree", parentPID)
	}
	if !procctl.Alive(childPID) {
		t.Fatalf("child %d should be alive before KillTree", childPID)
	}

	if err := procctl.KillTree(cmd); err != nil {
		t.Logf("KillTree returned: %v (may be expected once the process is already gone)", err)
	}

	// Reap the direct child immediately: on unix a killed-but-unreaped
	// process is a zombie, which still answers kill(pid, 0) as "alive" until
	// its own parent (this test) calls Wait. The grandchild is reparented
	// away and reaped by its new parent, so it does not need this step.
	_ = cmd.Wait() //nolint:errcheck // reaping the process; exit status is irrelevant to this test

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !procctl.Alive(parentPID) && !procctl.Alive(childPID) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if procctl.Alive(parentPID) {
		t.Errorf("parent %d still alive after KillTree", parentPID)
	}
	if procctl.Alive(childPID) {
		t.Errorf("grandchild %d still alive after KillTree", childPID)
	}
}

// TestInterrupt_UnixSendsSignal asserts Interrupt delivers SIGINT and the
// sleeper exits on its own. Windows has no cross-console graceful signal, so
// this is unix-only; the Windows Interrupt contract is pinned in
// procctl_windows_test.go.
func TestInterrupt_UnixSendsSignal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Interrupt has no graceful path on windows; see procctl_windows_test.go")
	}

	cmd := exec.Command(sleeperBin, "child")
	procctl.Configure(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := procctl.AfterStart(cmd); err != nil {
		t.Fatalf("AfterStart: %v", err)
	}
	t.Cleanup(func() {
		_ = procctl.KillTree(cmd) //nolint:errcheck // best-effort cleanup if the test already failed
		procctl.Release(cmd)
	})

	if err := procctl.Interrupt(cmd); err != nil {
		t.Fatalf("Interrupt: %v", err)
	}

	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case <-done:
		// sleeper does not install a SIGINT handler, so the default
		// disposition (terminate) applies.
	case <-time.After(2 * time.Second):
		t.Fatal("process did not exit after Interrupt")
	}
}

// TestKillTree_BeforeStart asserts KillTree on a never-started *exec.Cmd is a
// safe no-op.
func TestKillTree_BeforeStart(t *testing.T) {
	cmd := exec.Command(sleeperBin, "child")
	if err := procctl.KillTree(cmd); err != nil {
		t.Fatalf("KillTree on unstarted cmd should be nil, got %v", err)
	}
}

// TestKillTree_Idempotent asserts a second KillTree call after the process is
// already gone does not panic and returns without hanging.
func TestKillTree_Idempotent(t *testing.T) {
	cmd := exec.Command(sleeperBin, "child")
	procctl.Configure(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := procctl.AfterStart(cmd); err != nil {
		t.Logf("AfterStart returned an error: %v", err)
	}
	t.Cleanup(func() { procctl.Release(cmd) })

	if err := procctl.KillTree(cmd); err != nil {
		t.Logf("first KillTree returned: %v", err)
	}
	_ = cmd.Wait() //nolint:errcheck // reaping; exit status is irrelevant

	// Second call: no job is tracked anymore (or the process is already
	// gone), so this must not panic. The error, if any, is the platform's
	// "already finished" shape and callers treat it as success.
	if err := procctl.KillTree(cmd); err != nil {
		t.Logf("second KillTree returned (expected, process already gone): %v", err)
	}
}

// TestAlive_UnknownPID asserts Alive is false for a PID that plausibly does
// not exist.
func TestAlive_UnknownPID(t *testing.T) {
	if procctl.Alive(0) {
		t.Error("Alive(0) should be false")
	}
	if procctl.Alive(-1) {
		t.Error("Alive(-1) should be false")
	}
}
