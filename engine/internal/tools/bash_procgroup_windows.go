//go:build windows

package tools

import (
	"os/exec"

	"github.com/dsswift/ion/engine/internal/procctl"
)

// configureProcGroup places the command in a Job Object–tracked tree so that
// cancellation kills the entire subprocess tree, not just the direct child.
func configureProcGroup(cmd *exec.Cmd) {
	procctl.Configure(cmd)
	cmd.Cancel = func() error {
		return procctl.KillTree(cmd)
	}
}

// killCommandProcGroup kills the command's entire process tree via its Job
// Object (background execution path — there is no cancelling context to
// trigger cmd.Cancel, so TaskStop / session cleanup call this directly).
func killCommandProcGroup(cmd *exec.Cmd) error {
	return procctl.KillTree(cmd)
}
