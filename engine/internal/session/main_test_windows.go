//go:build windows

package session

import (
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// windowsShortTempRoot picks the shortest writable root available for the
// synthetic test HOME, because %TEMP% alone is not short enough to leave
// room for the fixed 74-byte MCP socket suffix (see shortenWindowsPath's
// doc comment for the byte accounting) -- shortening the leaf directory via
// its 8.3 alias only saves what that one segment contributes; it cannot
// shrink AppData\Local\Temp, none of whose segments are long enough to
// have a shorter 8.3 form in the first place.
//
// Preference order: RUNNER_TEMP (GitHub Actions' own hosted-runner temp
// root, conventionally D:\a\_temp -- short by construction, and reading an
// env var this specific has no false-positive risk outside that runner);
// then a directory at the drive root (short by construction, tried rather
// than assumed since drive-root write access is not guaranteed on every
// machine); then %TEMP% as the last resort, matching prior behavior when
// neither shortcut is available.
func windowsShortTempRoot() string {
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

// shortenWindowsPath returns the 8.3 short form of an existing Windows path,
// or path unchanged if the short form cannot be resolved (fails closed to
// the original, longer path rather than erroring the whole test run over a
// cosmetic shortening).
//
// os.TempDir() on Windows resolves to %TEMP%, typically
// C:\Users\<user>\AppData\Local\Temp -- 30+ bytes on its own, before this
// package's "ionh-<random>" test-HOME suffix and the CLI tool server's fixed
// "\.ion\mcp\sock-<64-hex-digest>" suffix (74 bytes) are added. That combined
// length blows well past the ~104-byte sun_path limit regardless of how
// short the random suffix is kept, which is what "/tmp" achieves for free on
// POSIX (3 bytes) and %TEMP% does not on Windows. GetShortPathName resolves
// each existing path segment to its legacy 8.3 alias (e.g. "AppData" ->
// "APPDAT~1"), which every NTFS volume generates by default, shrinking the
// prefix enough to leave room for the fixed suffix.
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
