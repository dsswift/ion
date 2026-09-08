//go:build windows

package main

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// detachProcess configures cmd so the spawned engine survives the spawning
// CLI process's console closing. CREATE_NEW_PROCESS_GROUP isolates it from
// the parent's Ctrl-C group; DETACHED_PROCESS gives it no console at all, so
// there is nothing for the parent's console teardown to signal.
func detachProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
}
