//go:build windows

package procctl_test

import (
	"os"
	"os/exec"
	"testing"

	"github.com/dsswift/ion/engine/internal/procctl"
)

// TestAlive_CurrentProcess asserts Alive is true for the running test binary's
// own PID.
func TestAlive_CurrentProcess(t *testing.T) {
	if !procctl.Alive(os.Getpid()) {
		t.Error("Alive(os.Getpid()) should be true")
	}
}

// TestAlive_ExitedProcess asserts Alive is false once a started-and-waited
// process has exited, distinguishing STILL_ACTIVE from a held-open handle.
func TestAlive_ExitedProcess(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	procctl.Configure(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if procctl.Alive(pid) {
		t.Errorf("Alive(%d) should be false after Wait", pid)
	}
}

// TestInterrupt_ReturnsErrNoGracefulSignal pins the Windows Interrupt
// contract: there is no cross-console graceful stop, so callers must fall
// back to KillTree.
func TestInterrupt_ReturnsErrNoGracefulSignal(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	if err := procctl.Interrupt(cmd); err != procctl.ErrNoGracefulSignal {
		t.Errorf("Interrupt should return ErrNoGracefulSignal, got %v", err)
	}
}

// TestAfterStart_AssignsJob asserts AfterStart on a freshly started process
// succeeds (a Job Object is created and the process assigned to it).
func TestAfterStart_AssignsJob(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/c", "exit", "0")
	procctl.Configure(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer procctl.Release(cmd)
	if err := procctl.AfterStart(cmd); err != nil {
		t.Errorf("AfterStart should succeed on a freshly started process, got %v", err)
	}
	_ = cmd.Wait() //nolint:errcheck // reaping; exit status is irrelevant to this test
}
