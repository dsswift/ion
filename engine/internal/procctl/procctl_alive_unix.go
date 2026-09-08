//go:build darwin || freebsd || netbsd || openbsd || dragonfly || solaris

package procctl

import (
	"os"
	"syscall"
)

// Alive reports whether a process exists. These Unix platforms do not expose
// the Linux /proc state file, so signal 0 is the available liveness probe.
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
