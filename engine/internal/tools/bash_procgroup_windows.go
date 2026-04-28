//go:build windows

package tools

import "os/exec"

// configureProcGroup is a no-op on Windows. Process group management
// (Setpgid / PGID signaling) is not available. The default
// exec.CommandContext behavior (TerminateProcess on the direct child)
// is used instead.
func configureProcGroup(cmd *exec.Cmd) {}
