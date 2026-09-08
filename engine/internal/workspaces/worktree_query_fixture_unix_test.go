//go:build !windows

// This file exercises a POSIX process tree: it shims git with a #!/bin/sh
// script that forks a detached descendant to hold stdout open, then confirms
// WaitDelay forces the pipe closed after context cancellation. The
// fork-and-signal shape (a background shell job, SIGKILL cleanup by raw pid)
// has no Windows equivalent, so this case is unix-only rather than
// runtime-skipped: syscall.Kill and #!/bin/sh both fail to build/run on
// Windows, not merely fail the assertion.
package workspaces

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestRunGitCtx_CancelledGitDescendantDoesNotHoldQueryOpen simulates a git
// executable that leaves a descendant holding stdout open after the parent is
// cancelled. WaitDelay must force the pipe closed so the query returns promptly.
func TestRunGitCtx_CancelledGitDescendantDoesNotHoldQueryOpen(t *testing.T) {
	binDir := t.TempDir()
	gitPath := filepath.Join(binDir, "git")
	pidFile := filepath.Join(t.TempDir(), "descendant.pid")
	t.Setenv("ION_TEST_DESCENDANT_PID", pidFile)
	script := "#!/bin/sh\nsleep 30 &\npid_tmp=\"$ION_TEST_DESCENDANT_PID.tmp\"\necho $! > \"$pid_tmp\"\nmv \"$pid_tmp\" \"$ION_TEST_DESCENDANT_PID\"\nsleep 30\n"
	if err := os.WriteFile(gitPath, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	started := time.Now()
	go func() {
		_, err := runGitCtx(ctx, t.TempDir(), "log", "-1")
		result <- err
	}()

	var pid int
	deadline := time.After(time.Second)
	for pid == 0 {
		pidBytes, readErr := os.ReadFile(pidFile)
		if readErr == nil {
			parsed, parseErr := strconv.Atoi(strings.TrimSpace(string(pidBytes)))
			if parseErr != nil {
				t.Fatalf("parse descendant pid %q: %v", pidBytes, parseErr)
			}
			pid = parsed
			break
		}
		if !os.IsNotExist(readErr) {
			t.Fatalf("read descendant pid: %v", readErr)
		}
		select {
		case <-deadline:
			t.Fatal("git shim never started its pipe-owning descendant")
		case <-time.After(time.Millisecond):
		}
	}
	defer func() {
		if killErr := syscall.Kill(pid, syscall.SIGKILL); killErr != nil && killErr != syscall.ESRCH {
			t.Fatalf("cleanup descendant process: %v", killErr)
		}
	}()

	cancel()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("runGitCtx succeeded after context cancellation")
		}
	case <-time.After(2 * gitQueryWaitDelay):
		t.Fatalf("runGitCtx exceeded %s after its descendant inherited stdout", 2*gitQueryWaitDelay)
	}
	if elapsed := time.Since(started); elapsed > 2*gitQueryWaitDelay+time.Second {
		t.Fatalf("runGitCtx returned after %s, want descendant pipe cleanup bounded by WaitDelay", elapsed)
	}
}
