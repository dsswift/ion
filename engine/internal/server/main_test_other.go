//go:build !windows

package server

// shortenWindowsPath is a no-op off Windows: POSIX has no 8.3-style
// short-path mechanism, and "/tmp" is already short enough that this
// package's synthetic test HOME never needs shortening there.
func shortenWindowsPath(path string) string { return path }
