//go:build windows

package integration

import "golang.org/x/sys/windows"

// windowsLongPath returns the canonical long-path form of an existing path,
// or path unchanged if it cannot be resolved. See
// internal/tools/longpath_windows_test.go's doc comment for the full
// rationale -- this is the tests/integration package's own copy, since
// Go test helpers are unexported and this package cannot import the other
// one's.
func windowsLongPath(path string) string {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return path
	}
	buf := make([]uint16, 4096)
	n, err := windows.GetLongPathName(p, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return path
	}
	return windows.UTF16ToString(buf[:n])
}
