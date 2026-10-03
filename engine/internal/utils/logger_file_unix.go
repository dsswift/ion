//go:build !windows

package utils

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// openLogFile opens engine.jsonl for appending, creating it when absent.
func openLogFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
}

// tryLogRotateLock takes the rotation lock without waiting. locked is false
// when another process holds it; err is set only when the lock could not be
// attempted at all.
func tryLogRotateLock(path string) (unlock func(), locked bool, err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, err
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close() //nolint:errcheck // lock not taken; nothing to release
		if errors.Is(err, unix.EWOULDBLOCK) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return func() {
		unix.Flock(int(f.Fd()), unix.LOCK_UN) //nolint:errcheck // closing the descriptor releases the lock regardless
		f.Close()                             //nolint:errcheck // lock file is reused; close only drops the handle
	}, true, nil
}
