package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
)

var requestCounter int64

// looksLikeHostPort returns true when path looks like "host:port" rather
// than a Unix domain socket path. Used to enable TCP listen/dial on any
// platform via ION_SOCKET_PATH=host:port.
func looksLikeHostPort(path string) bool {
	if len(path) == 0 || path[0] == '/' || path[0] == '.' {
		return false
	}
	return strings.Contains(path, ":")
}

func socketPath() string {
	if v := os.Getenv("ION_SOCKET_PATH"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		return "127.0.0.1:21017"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.sock")
}

// dialNetwork returns the network type for the socket path.
// Returns "tcp4" when the path looks like host:port (including Windows
// default and explicit ION_SOCKET_PATH overrides), or "unix" otherwise.
func dialNetwork() string {
	if looksLikeHostPort(socketPath()) {
		return "tcp4"
	}
	return "unix"
}

func pidPath() string {
	if v := os.Getenv("ION_PID_PATH"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.pid")
}

func exitPath() string {
	if v := os.Getenv("ION_EXIT_PATH"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.exit")
}

func nextRequestID() string {
	n := atomic.AddInt64(&requestCounter, 1)
	return fmt.Sprintf("cli-%d-%d", os.Getpid(), n)
}
