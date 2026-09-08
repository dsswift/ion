//go:build !windows

package cliprobe

import "path/filepath"

// installCandidates returns the fixed non-PATH locations to check for name
// before falling back to $PATH and a login-shell probe. env is os.Getenv (or
// a fake in tests); home is the user's home directory (may be empty when it
// cannot be resolved).
func installCandidates(name string, env func(string) string, home string) []string {
	_ = env // unix candidates are not env-derived; kept for signature parity with windows
	candidates := []string{
		filepath.Join("/usr/local/bin", name),
		filepath.Join("/opt/homebrew/bin", name),
	}
	if home != "" {
		candidates = append(candidates, filepath.Join(home, ".npm-global", "bin", name))
	}
	return candidates
}

// searchDescription names, in prose, everywhere Find looked. Used only in
// the not-found error so the message accurately reflects this platform's
// search order.
func searchDescription() string {
	return "standard install paths, $PATH, and login shell"
}

// toolchainCandidates returns the daemon-mode fallback locations for a build
// toolchain binary (node, esbuild) on unix, checked after $PATH.
func toolchainCandidates(name string, env func(string) string) []string {
	_ = env // unix candidates are not env-derived; kept for signature parity with windows
	return []string{
		filepath.Join("/opt/homebrew/bin", name),
		filepath.Join("/usr/local/bin", name),
	}
}

// toolchainSearchDescription names, in prose, everywhere FindToolchain
// looked on this platform.
func toolchainSearchDescription() string {
	return "$PATH, /opt/homebrew/bin, and /usr/local/bin"
}
