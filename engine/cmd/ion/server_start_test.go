package main

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/filelock"
)

// engineAddress reserves a loopback TCP address (dialNetwork treats host:port
// as TCP on every platform) and returns it with a func that starts serving
// connections on it until the test ends. Until serve runs, nothing answers.
func engineAddress(t *testing.T) (sock string, serve func()) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	sock = ln.Addr().String()
	ln.Close() //nolint:errcheck // free the port until serve binds it again
	return sock, func() {
		ln, err := net.Listen("tcp4", sock)
		if err != nil {
			t.Errorf("listen: %v", err)
			return
		}
		t.Cleanup(func() { ln.Close() }) //nolint:errcheck // test cleanup
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return
				}
				c.Close() //nolint:errcheck // probe connection
			}
		}()
	}
}

func stubEngineStarters(t *testing.T, managed func() bool, spawn func() (*os.Process, error)) {
	t.Helper()
	prevManaged, prevSpawn := managedEngineStart, spawnDetachedEngine
	managedEngineStart, spawnDetachedEngine = managed, spawn
	t.Cleanup(func() { managedEngineStart, spawnDetachedEngine = prevManaged, prevSpawn })
}

// When the service manager starts the engine, the CLI must not spawn one of
// its own beside it, and owns no process.
func TestEnsureServerPrefersServiceManager(t *testing.T) {
	sock, serve := engineAddress(t)
	spawned := false
	stubEngineStarters(t,
		func() bool { serve(); return true },
		func() (*os.Process, error) { spawned = true; return nil, errors.New("must not spawn") },
	)
	if proc := ensureServer(sock); proc != nil {
		t.Fatalf("ensureServer returned a process for a managed engine: pid %d", proc.Pid)
	}
	if spawned {
		t.Fatal("ensureServer spawned an engine although the service manager started one")
	}
}

// Without a service manager, the CLI spawns the engine and owns it.
func TestEnsureServerSpawnsWithoutServiceManager(t *testing.T) {
	sock, serve := engineAddress(t)
	self, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	stubEngineStarters(t,
		func() bool { return false },
		func() (*os.Process, error) { serve(); return self, nil },
	)
	if proc := ensureServer(sock); proc != self {
		t.Fatalf("ensureServer returned %v, want the spawned process", proc)
	}
}

// A running engine is never started again.
func TestEnsureServerLeavesRunningEngine(t *testing.T) {
	sock, serve := engineAddress(t)
	serve()
	stubEngineStarters(t,
		func() bool { t.Fatal("asked the service manager although an engine answers"); return false },
		func() (*os.Process, error) { t.Fatal("spawned although an engine answers"); return nil, nil },
	)
	if proc := ensureServer(sock); proc != nil {
		t.Fatalf("ensureServer returned a process for a running engine: pid %d", proc.Pid)
	}
}

// `ion serve` losing the PID lock to a live engine exits 0, so a service
// manager that restarts on failure stops retrying; other lock errors fail.
func TestServeLockExitCode(t *testing.T) {
	dir := t.TempDir()
	held, err := filelock.Acquire(filepath.Join(dir, "engine.pid"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { held.Release() }) //nolint:errcheck // test cleanup
	_, lockErr := filelock.Acquire(filepath.Join(dir, "engine.pid"))
	if lockErr == nil {
		t.Fatal("second Acquire succeeded while the lock is held")
	}
	if got := serveLockExitCode(lockErr); got != 0 {
		t.Errorf("exit code for a held lock = %d, want 0", got)
	}
	if got := serveLockExitCode(errors.New("filelock: open: permission denied")); got != 1 {
		t.Errorf("exit code for another lock failure = %d, want 1", got)
	}
}
