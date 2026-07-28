//go:build windows

package server

import "golang.org/x/sys/windows"

// setSocketBuffers sets SO_SNDBUF and SO_RCVBUF to size on the raw descriptor
// fd. The first failure wins and is returned; the caller logs it.
//
// The Windows setsockopt wrapper takes a windows.Handle rather than the int the
// Unix syscall package takes, which is why this is a per-platform file. The
// tuning is not Unix-only in purpose: on Windows the engine listens on TCP
// loopback (see DefaultSocketPath), and the same event burst that motivated the
// larger buffer applies to that listener.
func setSocketBuffers(fd uintptr, size int) error {
	h := windows.Handle(fd)
	if err := windows.SetsockoptInt(h, windows.SOL_SOCKET, windows.SO_SNDBUF, size); err != nil {
		return err
	}
	return windows.SetsockoptInt(h, windows.SOL_SOCKET, windows.SO_RCVBUF, size)
}
