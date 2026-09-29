//go:build !windows

package testhome

// ShortRoot returns "/tmp". os.TempDir() is not used because macOS's real
// temp root (/var/folders/<...>/T/) is long enough on its own to push the
// MCP socket path under a temp HOME past the Unix socket path limit.
func ShortRoot() string { return "/tmp" }

// ShortenPath is a no-op off Windows: POSIX has no 8.3-style short-path
// mechanism, and "/tmp" is already short enough.
func ShortenPath(path string) string { return path }
