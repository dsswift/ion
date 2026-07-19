//go:build windows

package tools

// logFdPressure is a no-op on Windows (fd limits are managed differently).
func logFdPressure() {}

// countOpenFds is not available on Windows; returns -1.
func countOpenFds() int { return -1 }
