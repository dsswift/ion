package sysmetrics

import (
	"os/exec"
	"runtime"
	"testing"
)

// startSleeper starts a long-lived child process and kills it at cleanup.
func startSleeper(t *testing.T) int {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("powershell", "-NoProfile", "-Command", "Start-Sleep -Seconds 60")
	} else {
		cmd = exec.Command("sleep", "60")
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("cannot start a child process: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill() //nolint:errcheck // test cleanup of a sleeper
		_ = cmd.Wait()         //nolint:errcheck // reaps the killed sleeper
	})
	return cmd.Process.Pid
}
