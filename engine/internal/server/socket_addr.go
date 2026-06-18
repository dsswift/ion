package server

import "strings"

// looksLikeHostPort returns true when path looks like "host:port" rather
// than a Unix domain socket path. Used to enable TCP listen/dial on any
// platform via ION_SOCKET_PATH=host:port.
func looksLikeHostPort(path string) bool {
	// Must contain a colon and must not start with "/" (absolute path)
	// or "." (relative path).
	if len(path) == 0 || path[0] == '/' || path[0] == '.' {
		return false
	}
	return strings.Contains(path, ":")
}
