package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	"github.com/dsswift/ion/engine/internal/utils"
)

var requestCounter int64

// looksLikeHostPort returns true when path looks like "host:port" rather
// than a Unix domain socket path. Used to enable TCP listen/dial on any
// platform via ION_SOCKET_PATH=host:port.
func looksLikeHostPort(path string) bool {
	// A Windows absolute path's drive-letter colon (e.g. "C:\Users\...")
	// otherwise satisfies the contains-":" check below and misroutes the
	// address into TCP mode instead of a Unix domain socket. See the
	// matching check in internal/server/socket_addr.go.
	if len(path) == 0 || path[0] == '/' || path[0] == '.' || isWindowsDriveAbsolutePath(path) {
		return false
	}
	return strings.Contains(path, ":")
}

// isWindowsDriveAbsolutePath reports whether path starts with a drive
// letter followed by ":\" or ":/" (e.g. "C:\...", "d:/...").
func isWindowsDriveAbsolutePath(path string) bool {
	if len(path) < 3 {
		return false
	}
	c := path[0]
	isLetter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
	return isLetter && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}

// ionDataDir returns the root data directory for this engine instance.
// When ION_DATA_DIR is set it is used as-is, allowing multiple engine
// instances to coexist on the same machine without colliding on shared
// filesystem paths (PID lock, socket, conversations, scheduler).
// When unset the default ~/.ion/ is returned.
func ionDataDir() string {
	if v := os.Getenv("ION_DATA_DIR"); v != "" {
		return v
	}
	home, _ := utils.UserHomeDir() //nolint:errcheck // empty home falls back to a relative .ion path
	return filepath.Join(home, ".ion")
}

// resolveSocketPath returns the address this engine listens on and clients
// dial, or an error when no unambiguous address exists for this user.
//
// ION_SOCKET_PATH overrides everything -- a deployment with its own port plan,
// a test harness, or a second instance on one machine sets it and nothing here
// applies. Otherwise Unix platforms get a per-user socket file under the
// user's own data directory, and Windows gets a loopback port derived from the
// user's SID (see userScopedPort): Go has no native named-pipe listener.
//
// The Windows branch can fail, and failing is the point. There used to be a
// fallback to one fixed port (21017) whenever the SID could not be read. On a
// single-user workstation that was harmless. On a multi-session host it was
// the worst possible outcome: two users whose SID lookups both failed would
// resolve to the SAME address, and the second desktop would attach to the
// first user's engine -- their conversations, their credentials, their file
// access -- with nothing on screen to say so. A refusal to start is loud,
// recoverable, and cannot leak anything. An address collision is silent and
// cannot be undone after the fact. So there is no fallback: an engine that
// cannot name its own user does not listen, and a client that cannot name its
// own user does not dial.
func resolveSocketPath() (string, error) {
	if v := os.Getenv("ION_SOCKET_PATH"); v != "" {
		return v, nil
	}
	if runtime.GOOS == "windows" {
		port, err := userScopedPort()
		if err != nil {
			return "", fmt.Errorf("cannot derive this user's engine address: %w", err)
		}
		return fmt.Sprintf("127.0.0.1:%d", port), nil
	}
	return filepath.Join(ionDataDir(), "engine.sock"), nil
}

// socketPathOrExit is resolveSocketPath for the CLI verbs, which have no
// caller to return an error to. It prints the reason and exits non-zero --
// the visible failure the doc comment above describes, rather than a
// connection to an address that may belong to somebody else.
func socketPathOrExit() string {
	sock, err := resolveSocketPath()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		fmt.Fprintln(os.Stderr, "Set ION_SOCKET_PATH to name the engine address explicitly if this machine cannot report your user identity.")
		os.Exit(1)
	}
	return sock
}

// dialNetwork returns the network type for a resolved socket path.
// Returns "tcp4" when the path looks like host:port (including the Windows
// default and explicit ION_SOCKET_PATH overrides), or "unix" otherwise.
//
// Takes the already-resolved path rather than re-resolving: on Windows a
// second resolution is a second SID lookup that could disagree with the first,
// and the network must always describe the address actually being dialled.
func dialNetwork(sock string) string {
	if looksLikeHostPort(sock) {
		return "tcp4"
	}
	return "unix"
}

func pidPath() string {
	if v := os.Getenv("ION_PID_PATH"); v != "" {
		return v
	}
	return filepath.Join(ionDataDir(), "engine.pid")
}

func exitPath() string {
	if v := os.Getenv("ION_EXIT_PATH"); v != "" {
		return v
	}
	return filepath.Join(ionDataDir(), "engine.exit")
}

func nextRequestID() string {
	n := atomic.AddInt64(&requestCounter, 1)
	return fmt.Sprintf("cli-%d-%d", os.Getpid(), n)
}
