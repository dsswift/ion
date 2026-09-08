//go:build !windows

package procctl

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Configure places cmd in its own process group so KillTree and Interrupt
// can target the whole tree by negative PID.
func Configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	utils.LogWithFields(utils.LevelDebug, tag, "configured process group", map[string]any{
		"platform": "unix",
	})
}

// AfterStart is a no-op on unix: the process group established by Configure
// is already sufficient to track the tree.
func AfterStart(cmd *exec.Cmd) error { return nil }

// Release is a no-op on unix: there is no per-command tracking state to free.
func Release(cmd *exec.Cmd) {}

// Interrupt sends SIGINT to the process group rooted at cmd.
func Interrupt(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		utils.LogWithFields(utils.LevelError, tag, "interrupt: getpgid failed, killing process directly", map[string]any{
			"pid":      cmd.Process.Pid,
			"platform": "unix",
			"error":    err.Error(),
		})
		return cmd.Process.Kill()
	}
	utils.LogWithFields(utils.LevelInfo, tag, "interrupt process group", map[string]any{
		"pid":      cmd.Process.Pid,
		"pgid":     pgid,
		"platform": "unix",
	})
	return syscall.Kill(-pgid, syscall.SIGINT)
}

// KillTree ends the whole process group rooted at cmd.
func KillTree(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	pgid, err := syscall.Getpgid(cmd.Process.Pid)
	if err != nil {
		utils.LogWithFields(utils.LevelError, tag, "kill tree: getpgid failed, killing process directly", map[string]any{
			"pid":      cmd.Process.Pid,
			"platform": "unix",
			"error":    err.Error(),
		})
		return cmd.Process.Kill()
	}
	utils.LogWithFields(utils.LevelInfo, tag, "kill process group", map[string]any{
		"pid":      cmd.Process.Pid,
		"pgid":     pgid,
		"platform": "unix",
	})
	return syscall.Kill(-pgid, syscall.SIGKILL)
}

// Alive reports whether a process with pid exists, using signal 0.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc.Signal(syscall.Signal(0)) == nil
}
