//go:build !windows

package tools

import (
	"os/exec"
	"syscall"
)

// configureProcGroup places the command in its own process group so that
// cancellation kills the entire subprocess tree, not just the direct child.
func configureProcGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// Kill the entire process group (negative PID = PGID)
		pgid, err := syscall.Getpgid(cmd.Process.Pid)
		if err != nil {
			return cmd.Process.Kill()
		}
		return syscall.Kill(-pgid, syscall.SIGKILL)
	}
}
