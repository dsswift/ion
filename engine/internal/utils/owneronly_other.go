//go:build !windows

package utils

// RestrictToOwner is a no-op off Windows: the 0o600 mode the caller already
// passed to the file's creation is real there, and is what restricts it.
func RestrictToOwner(string) error { return nil }
