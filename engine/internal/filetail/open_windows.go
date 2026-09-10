//go:build windows

package filetail

import (
	"os"

	"golang.org/x/sys/windows"
)

// openShared opens path for reading with FILE_SHARE_DELETE included in its
// share mode, so a log rotator can rename or delete the file while this
// handle is still open -- the property this package's whole "drain the
// renamed file, then follow the new one" design depends on.
//
// os.Open on Windows does not do this: syscall.Open there hardcodes
// FILE_SHARE_READ|FILE_SHARE_WRITE (see syscall_windows.go), omitting
// FILE_SHARE_DELETE, so a rename of an open file fails with "the process
// cannot access the file because it is being used by another process" --
// not a permissions problem, a share-mode omission. POSIX has no analogous
// restriction (rename never needs the target's cooperation), which is why
// this is a Windows-only file.
func openShared(path string) (*os.File, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(h), path), nil
}
