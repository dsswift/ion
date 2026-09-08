//go:build windows

package server

import "golang.org/x/sys/windows"

// shortenWindowsPath returns the 8.3 short form of an existing Windows path,
// or path unchanged if the short form cannot be resolved (fails closed to
// the original, longer path rather than erroring the whole test run over a
// cosmetic shortening). See internal/session/main_test_windows.go's doc
// comment for the byte accounting this exists to satisfy -- this package's
// ToolServer tests hit the identical ~/.ion/mcp/sock-<64-hex-digest> suffix.
func shortenWindowsPath(path string) string {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return path
	}
	buf := make([]uint16, 4096)
	n, err := windows.GetShortPathName(p, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 || int(n) > len(buf) {
		return path
	}
	return windows.UTF16ToString(buf[:n])
}
