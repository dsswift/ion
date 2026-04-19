package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// SSHConfig holds connection parameters for SSH-based bash execution.
type SSHConfig struct {
	Host           string
	Port           int
	Username       string
	PrivateKeyPath string
}

// SSHBashOperations executes commands on a remote host via ssh.
type SSHBashOperations struct {
	Config SSHConfig
}

func (s *SSHBashOperations) Exec(ctx context.Context, command, cwd string, opts ExecOptions) (*ExecResult, error) {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 120 * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Build the ssh command.
	args := []string{}
	if s.Config.PrivateKeyPath != "" {
		args = append(args, "-i", s.Config.PrivateKeyPath)
	}

	port := s.Config.Port
	if port == 0 {
		port = 22
	}
	args = append(args, "-p", fmt.Sprintf("%d", port))

	// Disable strict host key checking for automation.
	args = append(args, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes")

	target := s.Config.Username + "@" + s.Config.Host
	args = append(args, target)

	// Construct remote command: cd to cwd, set env, then run.
	remoteCmd := fmt.Sprintf("cd %s && %s", escapeShellArg(cwd), command)
	if opts.Env != nil {
		var envParts []string
		for k, v := range opts.Env {
			envParts = append(envParts, fmt.Sprintf("export %s=%s", k, escapeShellArg(v)))
		}
		remoteCmd = strings.Join(envParts, "; ") + "; " + remoteCmd
	}
	args = append(args, remoteCmd)

	cmd := exec.CommandContext(ctx, "ssh", args...)

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

func escapeShellArg(arg string) string {
	return "'" + strings.ReplaceAll(arg, "'", "'\\''") + "'"
}
