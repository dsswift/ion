//go:build !windows

package tools

// windowsLongPath is a no-op off Windows: POSIX has no short/long path
// aliasing, so t.TempDir()'s path already matches what a spawned shell
// reports as its working directory.
func windowsLongPath(path string) string { return path }
