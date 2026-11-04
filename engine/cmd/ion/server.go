package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Seams over the two ways ensureServer starts an engine, replaced in tests.
var (
	managedEngineStart  = startManagedEngine
	spawnDetachedEngine = spawnEngineProcess
)

// ensureServer checks if engine is reachable; if not, starts one and waits
// for the socket to accept connections. Where a service manager runs the
// engine (the macOS LaunchAgent), it asks the manager to start it, so the
// engine stays the manager's own and the manager restarts it after a crash.
// Otherwise it spawns a detached `ion serve`.
//
// Returns the spawned engine process when this call spawned one, nil when an
// engine was already running or the service manager started it. The caller
// owns a returned process: either wait for it after asking it to shut down
// (waitForSpawnedServerExit) or let it outlive this CLI
// (releaseSpawnedServer).
func ensureServer(sock string) *os.Process {
	if engineAnswers(sock, 500*time.Millisecond) {
		return nil
	}
	command := invokingCommand()

	if managedEngineStart() {
		if waitForEngine(sock) {
			utils.LogWithFields(utils.LevelInfo, "main", "engine auto-started", map[string]any{"via": "service_manager", "command": command})
			return nil
		}
		fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
		os.Exit(1)
	}

	proc, err := spawnDetachedEngine()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot start engine: %s\n", err)
		os.Exit(1)
	}
	utils.LogWithFields(utils.LevelInfo, "main", "engine auto-started", map[string]any{
		"via": "spawn", "command": command, "pid": proc.Pid, "platform": runtime.GOOS,
	})
	if waitForEngine(sock) {
		return proc
	}
	fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
	os.Exit(1)
	return nil
}

// engineAnswers reports whether an engine accepts a connection on sock.
func engineAnswers(sock string, timeout time.Duration) bool {
	conn, err := net.DialTimeout(dialNetwork(sock), sock, timeout)
	if err != nil {
		return false
	}
	conn.Close() //nolint:errcheck // best-effort close of the liveness-probe conn
	return true
}

// waitForEngine polls sock for up to 5s until an engine answers.
func waitForEngine(sock string) bool {
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		if engineAnswers(sock, 200*time.Millisecond) {
			return true
		}
	}
	return false
}

// spawnEngineProcess starts a detached `ion serve`. Its stdout and stderr go
// to the same files the LaunchAgent writes, so a crash in a spawned engine
// leaves its stack where a managed engine's would be.
func spawnEngineProcess() (*os.Process, error) {
	exe, _ := os.Executable() //nolint:errcheck // empty exe path surfaces as a cmd.Start error below
	cmd := exec.Command(exe, "serve")
	dir := utils.IonDir()
	stdout := openEngineOutput(filepath.Join(dir, "engine-stdout.log"))
	stderr := openEngineOutput(filepath.Join(dir, "engine-stderr.log"))
	if stdout != nil {
		cmd.Stdout = stdout
		defer stdout.Close() //nolint:errcheck // the child holds its own descriptor
	}
	if stderr != nil {
		cmd.Stderr = stderr
		defer stderr.Close() //nolint:errcheck // the child holds its own descriptor
	}
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd.Process, nil
}

// openEngineOutput opens path for appending, or returns nil (output
// discarded) when it cannot.
func openEngineOutput(path string) *os.File {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		utils.LogWithFields(utils.LevelWarn, "main", "engine output directory unavailable", map[string]any{"path": path, "error": err.Error()})
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "main", "engine output file unavailable", map[string]any{"path": path, "error": err.Error()})
		return nil
	}
	return f
}

// invokingCommand names the ion subcommand this process runs, for the log.
func invokingCommand() string {
	if len(os.Args) > 1 {
		return os.Args[1]
	}
	return ""
}

// releaseSpawnedServer lets an engine started by ensureServer outlive this CLI
// process. Nil-safe: an engine that was already running needs nothing.
func releaseSpawnedServer(proc *os.Process) {
	if proc == nil {
		return
	}
	if err := proc.Release(); err != nil {
		utils.LogWithFields(utils.LevelDebug, "main", "release spawned engine handle failed", map[string]any{"pid": proc.Pid, "error": err.Error()})
	}
}

// waitForSpawnedServerExit waits up to budget for an engine this CLI spawned,
// and has already asked to shut down, to exit. Returns whether it exited.
//
// The CLI must not return first: when it is a container's PID 1 its exit tears
// down the container and kills the engine mid-shutdown, before the engine
// drains telemetry and log egress. Waiting on the child also reaps it, which a
// PID 1 that never waits would not do.
func waitForSpawnedServerExit(proc *os.Process, budget time.Duration) bool {
	started := time.Now()
	type waitResult struct {
		state *os.ProcessState
		err   error
	}
	done := make(chan waitResult, 1)
	go func() {
		state, err := proc.Wait()
		done <- waitResult{state: state, err: err}
	}()

	select {
	case r := <-done:
		fields := map[string]any{"pid": proc.Pid, "duration_ms": time.Since(started).Milliseconds()}
		if r.err != nil {
			fields["error"] = r.err.Error()
			utils.LogWithFields(utils.LevelWarn, "prompt", "wait for spawned engine exit failed", fields)
			return false
		}
		fields["exit_code"] = r.state.ExitCode()
		utils.LogWithFields(utils.LevelInfo, "prompt", "spawned engine exited after shutdown", fields)
		return true
	case <-time.After(budget):
		utils.LogWithFields(utils.LevelWarn, "prompt", "spawned engine did not exit within its shutdown budget", map[string]any{
			"pid": proc.Pid, "budget_ms": budget.Milliseconds(),
		})
		return false
	}
}

// serveLockExitCode is how `ion serve` exits when it cannot take the PID
// lock. A live engine holding the lock is success: the engine the caller
// wanted is running, and a service manager that restarts on failure (the
// LaunchAgent's KeepAlive) must not retry. Any other lock failure is one.
func serveLockExitCode(err error) int {
	var held *filelock.HeldError
	if errors.As(err, &held) {
		return 0
	}
	return 1
}
