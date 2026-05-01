package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
)

var requestCounter int64

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

// dialNetwork returns the network type for the current platform.
// Windows uses TCP loopback; all other platforms use Unix domain sockets.
func dialNetwork() string {
	if runtime.GOOS == "windows" {
		return "tcp"
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

func nextRequestID() string {
	n := atomic.AddInt64(&requestCounter, 1)
	return fmt.Sprintf("cli-%d-%d", os.Getpid(), n)
}
