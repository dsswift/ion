//go:build windows

package testhome

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// ShortRoot picks the shortest writable root available for a temp HOME,
// because %TEMP% alone is not short enough to leave room for the fixed
// 74-byte MCP socket suffix (see ShortenPath for the byte accounting).
// Shortening the leaf directory via its 8.3 alias only saves what that one
// segment contributes; it cannot shrink AppData\Local\Temp, none of whose
// segments are long enough to have a shorter 8.3 form.
//
// Preference order: RUNNER_TEMP (GitHub Actions' hosted-runner temp root,
// conventionally D:\a\_temp, short by construction); then a directory at the
// drive root (tried rather than assumed, since drive-root write access is not
// guaranteed); then %TEMP% as the last resort.
func ShortRoot() string {
	if rt := os.Getenv("RUNNER_TEMP"); rt != "" {
		if fi, err := os.Stat(rt); err == nil && fi.IsDir() {
			return rt
		}
	}
	if drive := os.Getenv("SystemDrive"); drive != "" {
		candidate := filepath.Join(drive+`\`, "ion-wtmp")
		if err := os.MkdirAll(candidate, 0o700); err == nil {
			return candidate
		}
	}
	return os.TempDir()
}

// ShortenPath returns the 8.3 short form of an existing Windows path, or path
// unchanged if the short form cannot be resolved (fails closed to the
// original, longer path rather than erroring the whole test run over a
// cosmetic shortening).
//
// %TEMP% is typically C:\Users\<user>\AppData\Local\Temp, 30+ bytes on its
// own, before the "<prefix><random>" temp-HOME leaf and the CLI tool server's
// fixed "\.ion\mcp\sock-<64-hex-digest>" suffix (74 bytes) are added. That
// overruns the ~104-byte sun_path limit. GetShortPathName resolves each
// existing segment to its legacy 8.3 alias (e.g. "AppData" -> "APPDAT~1"),
// which every NTFS volume generates by default.
func ShortenPath(path string) string {
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
