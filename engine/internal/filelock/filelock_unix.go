//go:build !windows

package filelock

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// tryLock takes a non-blocking exclusive flock. flock locks belong to the open
// file description, so a second open of the same path in this process
// conflicts exactly like another process would.
func tryLock(f *os.File) error {
	err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
	if errors.Is(err, unix.EWOULDBLOCK) || errors.Is(err, unix.EAGAIN) {
		return errLockHeld
	}
	return err
}

func unlock(f *os.File) error {
	return unix.Flock(int(f.Fd()), unix.LOCK_UN)
}

// releaseFile unlinks the lock file while the lock is still held, then drops
// the lock. Unlinking first means no other acquirer can lock this inode and
// believe it owns the path; Acquire's samePath check rejects a lock taken on
// the unlinked inode.
func releaseFile(f *os.File, lockPath string) error {
	removeErr := os.Remove(lockPath)
	if errors.Is(removeErr, os.ErrNotExist) {
		removeErr = nil
	}
	unlockErr := unlock(f)
	closeErr := f.Close()
	if err := errors.Join(removeErr, unlockErr, closeErr); err != nil {
		return fmt.Errorf("filelock: release: %w", err)
	}
	return nil
}
