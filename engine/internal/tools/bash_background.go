package tools

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// bash_background.go carries the background execution path for the Bash tool
// (run_in_background: true). A background command outlives the tool call: the
// tool returns immediately with a task ID and an output-file path; the
// process runs detached from the per-call context and is owned by the tasks
// registry (tasks_bash.go) until it exits, TaskStop kills it, or the owning
// session stops.

// backgroundTailLimit bounds the in-memory output tail kept per background
// task for cheap TaskGet reads. The full output is always on disk at the
// task's OutputPath.
const backgroundTailLimit = 16 * 1024

// BackgroundBashOperations is the optional capability interface a
// BashOperations backend implements to support run_in_background. It is
// deliberately separate from BashOperations so existing backends (sandboxed,
// SSH, Docker) keep compiling; a backend without the capability yields a
// clean tool error instead of a broken half-implementation.
type BackgroundBashOperations interface {
	// StartBackground launches the command detached from ctx's cancellation
	// (ctx is used only for setup values such as the shell config). The
	// returned handle owns the process lifetime.
	StartBackground(ctx context.Context, command, cwd string, opts ExecOptions) (*BackgroundHandle, error)
}

// BackgroundHandle tracks a running background command.
type BackgroundHandle struct {
	// PID of the spawned shell process.
	PID int
	// OutputPath is the on-disk file receiving interleaved stdout+stderr.
	OutputPath string
	// Done is closed after the process exits; ExitCode() is valid then.
	Done <-chan struct{}

	mu       sync.Mutex
	exitCode int
	tail     *tailBuffer
	cmd      *exec.Cmd
}

// ExitCode returns the process exit code. Valid only after Done is closed.
func (h *BackgroundHandle) ExitCode() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.exitCode
}

// Tail returns the bounded in-memory tail of the command's output.
func (h *BackgroundHandle) Tail() string {
	return h.tail.String()
}

// Stop kills the process group. Safe to call multiple times and after exit.
func (h *BackgroundHandle) Stop() {
	h.mu.Lock()
	cmd := h.cmd
	h.mu.Unlock()
	if cmd == nil {
		return
	}
	if err := killCommandProcGroup(cmd); err != nil {
		utils.LogWithFields(utils.LevelWarn, "tools.bash", "background stop: kill failed", map[string]any{"pid": h.PID, "error": err.Error()})
	}
}

// tailBuffer is a bounded rolling buffer of the most recent output bytes.
type tailBuffer struct {
	mu    sync.Mutex
	buf   []byte
	limit int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.limit {
		t.buf = t.buf[len(t.buf)-t.limit:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// backgroundOutputDir returns the directory for background task output files
// (~/.ion/tasks), creating it if needed.
func backgroundOutputDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	dir := filepath.Join(home, ".ion", "tasks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create tasks dir: %w", err)
	}
	return dir, nil
}

// StartBackground implements BackgroundBashOperations for the local backend.
// The process is detached from the per-call context: its lifetime is owned by
// the returned handle (TaskStop, session cleanup) — a finished tool call or
// aborted run must not kill a deliberately-backgrounded process.
func (l *LocalBashOperations) StartBackground(ctx context.Context, command, cwd string, opts ExecOptions) (*BackgroundHandle, error) {
	dir, err := backgroundOutputDir()
	if err != nil {
		return nil, err
	}
	outFile, err := os.CreateTemp(dir, "bash-*.out")
	if err != nil {
		return nil, fmt.Errorf("create output file: %w", err)
	}

	// Resolve the shell from ctx values (login-shell config), then run the
	// command with a non-cancelling context so ctx cancellation cannot
	// reach the process. Cleanup ownership: handle.Stop / tasks registry.
	shell, args := shellCommand(ctx, command)
	cmd := exec.CommandContext(context.WithoutCancel(ctx), shell, args...)
	cmd.Dir = cwd
	cmd.Stdin = nil
	if opts.Env != nil {
		env := os.Environ()
		for k, v := range opts.Env {
			env = append(env, k+"="+v)
		}
		cmd.Env = env
	}
	configureProcGroup(cmd)

	tail := &tailBuffer{limit: backgroundTailLimit}
	sink := io.MultiWriter(outFile, tail)
	cmd.Stdout = sink
	cmd.Stderr = sink

	logFdPressure()

	if err := cmd.Start(); err != nil {
		outFile.Close()          //nolint:errcheck // best-effort cleanup on spawn failure
		os.Remove(outFile.Name()) //nolint:errcheck // best-effort cleanup on spawn failure
		return nil, fmt.Errorf("start background command: %w", err)
	}

	done := make(chan struct{})
	handle := &BackgroundHandle{
		PID:        cmd.Process.Pid,
		OutputPath: outFile.Name(),
		Done:       done,
		tail:       tail,
		cmd:        cmd,
	}

	utils.LogWithFields(utils.LevelInfo, "tools.bash", "background command started", map[string]any{
		"pid": handle.PID, "path": handle.OutputPath, "cwd": cwd, "count": len(command),
	})

	go func() {
		waitErr := cmd.Wait()
		exit := 0
		if waitErr != nil {
			if exitErr, ok := waitErr.(*exec.ExitError); ok {
				exit = exitErr.ExitCode()
			} else {
				exit = -1
				utils.LogWithFields(utils.LevelWarn, "tools.bash", "background command wait error", map[string]any{"pid": handle.PID, "error": waitErr.Error()})
			}
		}
		if closeErr := outFile.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelWarn, "tools.bash", "background output file close failed", map[string]any{"path": handle.OutputPath, "error": closeErr.Error()})
		}
		handle.mu.Lock()
		handle.exitCode = exit
		handle.mu.Unlock()
		close(done)
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "background command exited", map[string]any{"pid": handle.PID, "exit_code": exit, "path": handle.OutputPath})
	}()

	return handle, nil
}
