//go:build !windows

package server

import "syscall"

// setSocketBuffers sets SO_SNDBUF and SO_RCVBUF to size on the raw descriptor
// fd. The first failure wins and is returned; the caller logs it.
//
// This exists as a per-platform file because the setsockopt descriptor type is
// not portable: the Unix syscall package takes an int, the Windows one takes a
// syscall.Handle. A single call site with int(fd) type-checks on Unix and fails
// to compile for GOOS=windows, which is what broke the windows/amd64 release
// build. Keeping the platform-specific call behind one narrow signature means
// the caller in server.go stays portable.
func setSocketBuffers(fd uintptr, size int) error {
	if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_SNDBUF, size); err != nil {
		return err
	}
	return syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, size)
}
