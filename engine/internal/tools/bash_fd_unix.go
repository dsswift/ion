//go:build !windows

package tools

import (
	"os"
	"syscall"

	"github.com/dsswift/ion/engine/internal/utils"
)

// logFdPressure logs the current open-fd count relative to the soft
// RLIMIT_NOFILE limit so operators can observe fd pressure before exhaustion.
// Called before each subprocess spawn. On systems where fd counting is
// unavailable, it logs only the limit.
func logFdPressure() {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return // cannot query limit; skip
	}
	soft := rl.Cur

	// Count open fds via /proc/self/fd (Linux) or /dev/fd (macOS).
	count := countOpenFds()

	utils.LogWithFields(utils.LevelDebug, "tools.bash", "fd pressure", map[string]any{
		"open_fds":  count,
		"fd_limit":  soft,
	})
}

// countOpenFds returns the number of open file descriptors in the current
// process. Returns -1 when counting is unavailable.
func countOpenFds() int {
	// /proc/self/fd is available on Linux; /dev/fd on macOS.
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		entries, err := os.ReadDir(dir)
		if err == nil {
			// Subtract 1: the ReadDir fd itself is counted before it closes.
			return len(entries) - 1
		}
	}
	return -1
}
