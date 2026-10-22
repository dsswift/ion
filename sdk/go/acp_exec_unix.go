//go:build unix

package ion

import (
	"os"
	"syscall"
)

// execEngine replaces this process with argv, so the ACP client's pipes and
// signals reach the engine directly. It returns only when the exec fails.
func execEngine(argv []string) (int, error) {
	return 0, syscall.Exec(argv[0], argv, os.Environ())
}
