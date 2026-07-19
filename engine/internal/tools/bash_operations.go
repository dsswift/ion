package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
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

	shell, args := shellCommand(ctx, command)
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

	// Put the command in its own process group so cancellation kills the
	// entire subprocess tree, not just the direct shell child.
	configureProcGroup(cmd)

	// WaitDelay bounds how long cmd.Wait() lingers after Cancel fires.
	// Without it, Wait() blocks until all I/O pipes close -- an orphaned
	// grandchild (daemon, setsid, changed PGID) that inherited stdout/stderr
	// can hold pipes open indefinitely, wedging the goroutine forever.
	cmd.WaitDelay = 5 * time.Second

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Log fd pressure before spawning so operators can observe accumulation
	// before the process reaches EMFILE (the engine process is long-lived and
	// accumulates open fds across all resources — extension pipes, sockets,
	// subprocess stdio; orphaned grandchildren from cancelled Bash calls
	// contribute to a gradual climb until os.Pipe fails with EMFILE).
	logFdPressure()

	err := cmd.Run()

	result := &ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
		} else {
			// Detect fd exhaustion (EMFILE/ENFILE) and return a structured,
			// actionable error instead of the raw "pipe: too many open files"
			// string that gives operators nothing to act on.
			if isFileDescriptorExhaustion(err) {
				count := countOpenFds()
				utils.LogWithFields(utils.LevelError, "tools.bash", "fd exhaustion: subprocess spawn failed", map[string]any{
					"open_fds": count,
					"error":    err.Error(),
					"command":  command,
				})
				return result, fmt.Errorf(
					"engine process has exhausted its file descriptor limit (EMFILE/ENFILE) — "+
						"open fds: %d. This is caused by accumulated subprocesses or orphaned "+
						"grandchildren from previous tool calls. Restarting the engine process "+
						"will clear the leaked descriptors. Raw error: %w", count, err)
			}
			return result, err
		}
	}

	return result, nil
}

// isFileDescriptorExhaustion reports whether err is an fd-exhaustion error
// (EMFILE — too many open files in process, or ENFILE — system file table full).
// exec.CommandContext wraps the os.Pipe error from Start as a plain error;
// check both the syscall errno and the error string to handle both forms.
func isFileDescriptorExhaustion(err error) bool {
	if errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE) {
		return true
	}
	msg := err.Error()
	return strings.Contains(msg, "too many open files") || strings.Contains(msg, "file table overflow")
}

// shellCommand returns the platform-appropriate shell and arguments for executing
// a command string. By default this is a non-login bash -c on POSIX and
// PowerShell on Windows. When a ShellConfig with UseLoginShell is present on the
// context (injected by the runloop from EngineRuntimeConfig.Shell), POSIX
// platforms instead run the user's login shell (e.g. zsh -lc) so rc files are
// sourced. The selection and resolved shell path are logged for observability.
func shellCommand(ctx context.Context, command string) (string, []string) {
	sc := types.ShellConfigFrom(ctx)
	shell, args, loginShell := sc.Resolve(command)
	if loginShell {
		utils.LogWithFields(utils.LevelDebug, "tools.bash", "shell resolved login", map[string]any{"path": shell})
	} else {
		utils.LogWithFields(utils.LevelDebug, "tools.bash", "shell resolved default", map[string]any{"path": shell})
	}
	return shell, args
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
