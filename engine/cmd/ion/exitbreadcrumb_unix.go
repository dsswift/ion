//go:build !windows

package main

import (
	"os"
	"syscall"
)

// signalZeroAlive sends signal 0 to the process to check liveness.
// Returns true if the signal was delivered (process exists).
func signalZeroAlive(proc *os.Process) bool {
	err := proc.Signal(syscall.Signal(0))
	return err == nil
}
