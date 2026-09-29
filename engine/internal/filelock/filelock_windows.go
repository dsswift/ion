//go:build windows

package filelock

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/windows"

	"github.com/dsswift/ion/engine/internal/utils"
)

// lockOffsetHigh places the locked byte far past the PID text. Windows byte
// range locks are mandatory, so locking the PID bytes themselves would stop a
// refused acquirer from reading the holder PID it reports.
const lockOffsetHigh = 0x7fffffff

func lockOverlapped() *windows.Overlapped {
	return &windows.Overlapped{OffsetHigh: lockOffsetHigh}
}

// tryLock takes a non-blocking exclusive LockFileEx lock. Byte range locks
// belong to the handle, so a second handle in this process conflicts exactly
// like another process would.
func tryLock(f *os.File) error {
	err := windows.LockFileEx(windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, lockOverlapped())
	if errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_IO_PENDING) {
		return errLockHeld
	}
	return err
}

func unlock(f *os.File) error {
	return windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, lockOverlapped())
}

// releaseFile drops the lock, closes the handle, then removes the file.
// Windows refuses to delete a file with an open handle that did not grant
// delete sharing, so the removal cannot happen while the lock is held. A
// removal that fails because another acquirer already has the file open is
// benign: the leftover file is reused by whoever locks it next.
func releaseFile(f *os.File, lockPath string) error {
	unlockErr := unlock(f)
	closeErr := f.Close()
	if err := os.Remove(lockPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		utils.LogWithFields(utils.LevelDebug, "filelock", "release left lock file in place", map[string]any{"path": lockPath, "error": err.Error()})
	}
	if err := errors.Join(unlockErr, closeErr); err != nil {
		return fmt.Errorf("filelock: release: %w", err)
	}
	return nil
}
