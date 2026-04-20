//go:build windows

package main

import "os/exec"

func detachProcess(cmd *exec.Cmd) {
	// Windows: no Setpgid equivalent needed for daemon spawn
}
