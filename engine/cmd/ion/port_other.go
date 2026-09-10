//go:build !windows

package main

import "errors"

// userScopedPort is never consulted off Windows: every other platform uses a
// per-user Unix domain socket under the user's own data directory, which is
// already isolated by path and needs no port at all.
//
// It returns an error rather than a plausible-looking port so that a caller
// reaching it on the wrong platform fails loudly instead of listening
// somewhere nobody expects. resolveSocketPath never calls it off Windows.
func userScopedPort() (int, error) {
	return 0, errors.New("a per-user port is Windows-only; other platforms use a per-user Unix socket path")
}
