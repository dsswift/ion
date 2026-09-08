// Command sleeper is a test helper used by procctl_test.go. With no
// arguments it spawns a copy of itself with the "child" argument, prints the
// child's PID to stdout (so the parent test can assert the child died too),
// then sleeps. With "child" it just sleeps. Both processes exit after a
// generous timeout so a test that fails to kill them does not leave the
// runner with an orphan hanging forever.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"time"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "child" {
		time.Sleep(2 * time.Minute)
		return
	}

	cmd := exec.Command(os.Args[0], "child")
	cmd.Stdout = nil
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "spawn child failed:", err)
		os.Exit(1)
	}
	fmt.Println(cmd.Process.Pid)
	os.Stdout.Sync() //nolint:errcheck // best-effort flush for the reading test

	time.Sleep(2 * time.Minute)
}
