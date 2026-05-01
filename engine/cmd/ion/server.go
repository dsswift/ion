package main

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"time"
)

// ensureServer checks if engine is reachable; if not, spawns `ion serve` in
// background and waits for socket to accept connections. Returns true if a
// new server was started (caller should shut it down for ephemeral use).
func ensureServer(sock string) bool {
	conn, err := net.DialTimeout(dialNetwork(), sock, 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return false
	}

	exe, _ := os.Executable()
	cmd := exec.Command(exe, "serve")
	cmd.Stdout = nil
	cmd.Stderr = nil
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot start engine: %s\n", err)
		os.Exit(1)
	}
	cmd.Process.Release()

	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		c, err := net.DialTimeout(dialNetwork(), sock, 200*time.Millisecond)
		if err == nil {
			c.Close()
			return true
		}
	}
	fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
	os.Exit(1)
	return false
}
