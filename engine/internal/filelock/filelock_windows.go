//go:build windows

package filelock

import (
	"fmt"
	"os/exec"
	"strings"
)

// isProcessAlive checks if a process with the given PID is running.
// On Windows, uses tasklist to query by PID since signal 0 is not supported.
func isProcessAlive(pid int) bool {
	cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH")
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), fmt.Sprintf("%d", pid))
}
