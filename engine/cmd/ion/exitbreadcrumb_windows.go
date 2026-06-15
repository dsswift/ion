//go:build windows

package main

import (
	"os"
)

// signalZeroAlive on Windows: os.Process.Signal is not supported for
// checking liveness. Conservatively return false so the UNCLEAN detection
// path reports the PID as dead, which is the correct behavior for a
// breadcrumb whose process is gone.
func signalZeroAlive(_ *os.Process) bool {
	return false
}
