//go:build windows

package utils

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// openLogFile opens engine.jsonl for appending, creating it when absent.
//
// os.OpenFile does not grant delete sharing on Windows, and without it any
// other process holding the file open makes the rename in rotation fail. The
// file is opened with read, write, and delete sharing so a writer in one
// process never blocks rotation by another. Append-only access makes every
// write land at the end of the file, even with several writers.
func openLogFile(path string) (*os.File, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(name,
		windows.FILE_APPEND_DATA|windows.FILE_READ_ATTRIBUTES|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}

// tryLogRotateLock takes the rotation lock without waiting. locked is false
// when another process holds it; err is set only when the lock could not be
// attempted at all.
func tryLogRotateLock(path string) (unlock func(), locked bool, err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, false, err
	}
	h := windows.Handle(f.Fd())
	overlapped := new(windows.Overlapped)
	err = windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlapped)
	if err != nil {
		f.Close() //nolint:errcheck // lock not taken; nothing to release
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return func() {
		windows.UnlockFileEx(h, 0, 1, 0, overlapped) //nolint:errcheck // closing the handle releases the lock regardless
		f.Close()                                    //nolint:errcheck // lock file is reused; close only drops the handle
	}, true, nil
}
