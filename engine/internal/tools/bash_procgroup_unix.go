//go:build !windows

package tools

import (
	"os/exec"
	"syscall"

	"github.com/dsswift/ion/engine/internal/utils"
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
			utils.LogWithFields(utils.LevelError, "tools.bash", "process group kill: getpgid failed, killing process directly", map[string]any{
				"pid":   cmd.Process.Pid,
				"error": err.Error(),
			})
			return cmd.Process.Kill()
		}
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "process group kill", map[string]any{
			"pid":  cmd.Process.Pid,
			"pgid": pgid,
		})
		return syscall.Kill(-pgid, syscall.SIGKILL)
	}
}
