//go:build !windows

package utils

// ShareIdentityWithOwnUser is a no-op off Windows, where the engine's Unix
// socket needs no peer lookup.
func ShareIdentityWithOwnUser() (bool, error) { return false, nil }
