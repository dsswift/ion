//go:build !windows

package session

import (
	"os"
	"syscall"
)

// findProcess wraps os.FindProcess for testability.
func findProcess(pid int) (*os.Process, error) {
	return os.FindProcess(pid)
}

// signalTerm returns the SIGTERM signal for graceful process termination.
func signalTerm() os.Signal {
	return syscall.SIGTERM
}

// signalKill returns the SIGKILL signal for forced process termination.
func signalKill() os.Signal {
	return syscall.SIGKILL
}
