//go:build !windows

package filelock

import (
	"os"
	"syscall"
)

// isProcessAlive checks if a process with the given PID is running.
// On Unix, sending signal 0 checks existence without side effects.
func isProcessAlive(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
