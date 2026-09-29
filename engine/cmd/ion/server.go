package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ensureServer checks if engine is reachable; if not, spawns `ion serve` in
// background and waits for socket to accept connections. Returns the spawned
// engine process when this call started one, nil when an engine was already
// running. The caller owns the returned process: either wait for it after
// asking it to shut down (waitForSpawnedServerExit) or let it outlive this
// CLI (releaseSpawnedServer).
func ensureServer(sock string) *os.Process {
	conn, err := net.DialTimeout(dialNetwork(sock), sock, 500*time.Millisecond)
	if err == nil {
		conn.Close() //nolint:errcheck // best-effort close of the liveness-probe conn
		return nil
	}

	exe, _ := os.Executable() //nolint:errcheck // empty exe path surfaces as a cmd.Start error below
	cmd := exec.Command(exe, "serve")
	cmd.Stdout = nil
	cmd.Stderr = nil
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot start engine: %s\n", err)
		os.Exit(1)
	}
	utils.LogWithFields(utils.LevelDebug, "main", "spawned detached engine", map[string]any{"pid": cmd.Process.Pid, "platform": runtime.GOOS})

	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		c, err := net.DialTimeout(dialNetwork(sock), sock, 200*time.Millisecond)
		if err == nil {
			c.Close() //nolint:errcheck // best-effort close of the liveness-probe conn
			return cmd.Process
		}
	}
	fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
	os.Exit(1)
	return nil
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
