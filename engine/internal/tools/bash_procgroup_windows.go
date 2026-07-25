//go:build windows

package tools

import "os/exec"

// configureProcGroup is a no-op on Windows. Process group management
// (Setpgid / PGID signaling) is not available. The default
// exec.CommandContext behavior (TerminateProcess on the direct child)
// is used instead.
func configureProcGroup(cmd *exec.Cmd) {}

// killCommandProcGroup kills the direct child on Windows (no PGID
// signaling). No-op when the process never started.
func killCommandProcGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
