package tools

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"runtime"
	"sync"
	"time"
)

// BashOperations is a pluggable interface for command execution.
// Default: LocalBashOperations (direct spawn). Enterprise harnesses swap in
// DockerBashOperations, SSHBashOperations, SandboxedBashOperations, etc.
type BashOperations interface {
	Exec(ctx context.Context, command, cwd string, opts ExecOptions) (*ExecResult, error)
}

// ExecOptions configures a single bash execution.
type ExecOptions struct {
	Timeout time.Duration
	Env     map[string]string
	OnData  func(data []byte)
}

// ExecResult holds the output of a bash execution.
type ExecResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
}

// LocalBashOperations executes commands via a local bash shell.
type LocalBashOperations struct{}

func (l *LocalBashOperations) Exec(ctx context.Context, command, cwd string, opts ExecOptions) (*ExecResult, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 120 * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	shell, args := shellCommand(command)
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = cwd
	cmd.Stdin = nil

	// Merge environment if provided.
	if opts.Env != nil {
		env := os.Environ()
		for k, v := range opts.Env {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	result := &ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			return result, err
		}
	}

	return result, nil
}

// shellCommand returns the platform-appropriate shell and arguments for executing
// a command string. On Windows, uses PowerShell; on all other platforms, uses bash.
func shellCommand(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		return "powershell", []string{"-NoProfile", "-Command", command}
	}
	return "bash", []string{"-c", command}
}

// Module-level singleton, protected by RWMutex.
var (
	bashOps   BashOperations = &LocalBashOperations{}
	bashOpsMu sync.RWMutex
)

// SetBashOperations replaces the global bash execution backend.
func SetBashOperations(ops BashOperations) {
	bashOpsMu.Lock()
	bashOps = ops
	bashOpsMu.Unlock()
}

// GetBashOperations returns the current bash execution backend.
func GetBashOperations() BashOperations {
	bashOpsMu.RLock()
	defer bashOpsMu.RUnlock()
	return bashOps
}
