//go:build !windows

package durablefile

import "syscall"

// pidAlive returns true if a process with the given PID exists.
func pidAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
