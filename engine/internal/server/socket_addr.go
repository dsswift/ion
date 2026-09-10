package server

import "strings"

// looksLikeHostPort returns true when path looks like "host:port" rather
// than a Unix domain socket path. Used to enable TCP listen/dial on any
// platform via ION_SOCKET_PATH=host:port.
func looksLikeHostPort(path string) bool {
	// Must contain a colon and must not start with "/" (absolute path),
	// "." (relative path), or a drive letter (a Windows absolute path,
	// e.g. "C:\Users\...\engine.sock" -- its drive-letter colon otherwise
	// satisfies the contains-":" check below and misroutes the address
	// into TCP mode instead of a Unix domain socket).
	if len(path) == 0 || path[0] == '/' || path[0] == '.' || isWindowsDriveAbsolutePath(path) {
		return false
	}
	return strings.Contains(path, ":")
}

// isWindowsDriveAbsolutePath reports whether path starts with a drive
// letter followed by ":\" or ":/" (e.g. "C:\...", "d:/..."). Checked as a
// plain string pattern rather than gated by runtime.GOOS: a path built by
// filepath.Join with a Windows-style root is a drive-letter path regardless
// of which platform is now evaluating it, which matters for tests that
// construct one explicitly.
func isWindowsDriveAbsolutePath(path string) bool {
	if len(path) < 3 {
		return false
	}
	c := path[0]
	isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	return isLetter && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}
