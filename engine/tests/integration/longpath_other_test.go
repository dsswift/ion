//go:build !windows

package integration

// windowsLongPath is a no-op off Windows: POSIX has no short/long path
// aliasing.
func windowsLongPath(path string) string { return path }
