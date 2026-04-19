//go:build windows

package session

import (
	"os"
)

// findProcess wraps os.FindProcess for testability.
func findProcess(pid int) (*os.Process, error) {
	return os.FindProcess(pid)
}

// signalTerm returns os.Kill on Windows since SIGTERM is not supported.
// Windows processes are terminated via TerminateProcess (os.Process.Kill).
func signalTerm() os.Signal {
	return os.Kill
}

// signalKill returns os.Kill on Windows (same as signalTerm -- Windows only
// supports forced termination via TerminateProcess).
func signalKill() os.Signal {
	return os.Kill
}
