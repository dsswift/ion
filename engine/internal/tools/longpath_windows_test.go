//go:build windows

package tools

import "golang.org/x/sys/windows"

// windowsLongPath returns the canonical long-path form of an existing path,
// or path unchanged if it cannot be resolved (fails closed to the original
// rather than erroring the test over a cosmetic normalization).
//
// GitHub Actions' windows-latest runners set %TEMP% using the 8.3 short
// form of the profile directory (e.g. C:\Users\RUNNER~1\AppData\...), which
// is what os.TempDir() and therefore t.TempDir() return. But a PowerShell
// child process resolves its own working directory to the long form
// (C:\Users\runneradmin\AppData\...) when reporting it back via
// Get-Location/pwd. Both strings name the identical directory -- the Bash
// tool really did start in the directory t.TempDir() created -- so a raw
// strings.Contains comparison between the two forms is a false failure,
// not a defect in command execution. Resolving the expected path to its
// long form before comparing removes the representation mismatch.
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
