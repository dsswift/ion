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
// background and waits for socket to accept connections. Returns true if a
// new server was started (caller should shut it down for ephemeral use).
func ensureServer(sock string) bool {
	conn, err := net.DialTimeout(dialNetwork(sock), sock, 500*time.Millisecond)
	if err == nil {
		conn.Close() //nolint:errcheck // best-effort close of the liveness-probe conn
		return false
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
	cmd.Process.Release() //nolint:errcheck // best-effort release of the detached engine process handle

	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		c, err := net.DialTimeout(dialNetwork(sock), sock, 200*time.Millisecond)
		if err == nil {
			c.Close() //nolint:errcheck // best-effort close of the liveness-probe conn
			return true
		}
	}
	fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
	os.Exit(1)
	return false
}
