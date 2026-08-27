//go:build !windows

// Background-bash tests use POSIX shell commands and probe process liveness
// via syscall.Kill(pid, 0); Windows CI has no bash and no signal 0.

package tools

import (
	"context"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// clearBashTasks removes all Kind=="bash" tasks between tests (the registry
// is package-global).
func clearBashTasks(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		tasksMu.Lock()
		for id, task := range tasks {
			if task.Kind == "bash" {
				if task.stop != nil {
					task.stop()
				}
				delete(tasks, id)
			}
		}
		tasksMu.Unlock()
	})
}

// waitForTaskStatus polls until the task reaches a terminal status or times out.
func waitForTaskStatus(t *testing.T, taskID string, want string, timeout time.Duration) *TaskInfo {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tasksMu.RLock()
		task := tasks[taskID]
		status := ""
		if task != nil {
			status = task.Status
		}
		tasksMu.RUnlock()
		if status == want {
			return task
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("task %s did not reach status %q within %s", taskID, want, timeout)
	return nil
}

// extractTaskID pulls the task ID out of the Bash tool's background result.
func extractTaskID(t *testing.T, content string) string {
	t.Helper()
	for _, line := range strings.Split(content, "\n") {
		if rest, ok := strings.CutPrefix(line, "Background task started: "); ok {
			return rest
		}
	}
	t.Fatalf("no task ID in result: %q", content)
	return ""
}

// extractOutputPath pulls the output-file path out of the background result.
func extractOutputPath(t *testing.T, content string) string {
	t.Helper()
	for _, line := range strings.Split(content, "\n") {
		if rest, ok := strings.CutPrefix(line, "Output file: "); ok {
			return rest
		}
	}
	t.Fatalf("no output path in result: %q", content)
	return ""
}

// TestBashRunInBackground_ImmediateReturn pins the core contract: the tool
// returns immediately with a task ID and output path while the command is
// still running, and the task completes with exit code 0 afterward.
func TestBashRunInBackground_ImmediateReturn(t *testing.T) {
	clearBashTasks(t)

	start := time.Now()
	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "sleep 0.3; echo done-marker",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Errorf("background start took %s — should return before the command finishes", elapsed)
	}

	taskID := extractTaskID(t, result.Content)
	if !strings.HasPrefix(taskID, "bash-") {
		t.Errorf("task ID = %q, want bash- prefix", taskID)
	}

	task := waitForTaskStatus(t, taskID, "completed", 5*time.Second)
	if task.ExitCode != 0 {
		t.Errorf("exit code = %d, want 0", task.ExitCode)
	}
}

// TestBashRunInBackground_OutputFileAccrues pins output capture: stdout and
// stderr land in the output file and the in-memory tail.
func TestBashRunInBackground_OutputFileAccrues(t *testing.T) {
	clearBashTasks(t)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "echo line-a; echo line-err >&2; echo line-b",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	taskID := extractTaskID(t, result.Content)
	outPath := extractOutputPath(t, result.Content)
	task := waitForTaskStatus(t, taskID, "completed", 5*time.Second)

	data, readErr := os.ReadFile(outPath)
	if readErr != nil {
		t.Fatalf("read output file: %v", readErr)
	}
	out := string(data)
	for _, want := range []string{"line-a", "line-err", "line-b"} {
		if !strings.Contains(out, want) {
			t.Errorf("output file missing %q: %q", want, out)
		}
	}
	if tail := task.tail(); !strings.Contains(tail, "line-a") || !strings.Contains(tail, "line-err") {
		t.Errorf("in-memory tail missing output: %q", tail)
	}
}

// TestBashRunInBackground_TaskGetShowsBashFields pins the TaskGet rendering
// for bash tasks: output path, exit code on completion, and recent output.
func TestBashRunInBackground_TaskGetShowsBashFields(t *testing.T) {
	clearBashTasks(t) // Task tools are registered by TestMain

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "echo taskget-marker; exit 3",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	taskID := extractTaskID(t, result.Content)
	waitForTaskStatus(t, taskID, "failed", 5*time.Second)

	got, err := ExecuteTool(context.Background(), "TaskGet", map[string]any{"taskId": taskID}, "/tmp")
	if err != nil {
		t.Fatalf("TaskGet: %v", err)
	}
	for _, want := range []string{"Status: failed", "Output file: ", "Exit code: 3", "taskget-marker"} {
		if !strings.Contains(got.Content, want) {
			t.Errorf("TaskGet missing %q:\n%s", want, got.Content)
		}
	}
}

// TestBashRunInBackground_TaskStopKills pins TaskStop: a long-running
// background command is killed promptly and stamped "stopped".
func TestBashRunInBackground_TaskStopKills(t *testing.T) {
	clearBashTasks(t) // Task tools are registered by TestMain

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           `sh -c "sleep 60"`,
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	taskID := extractTaskID(t, result.Content)

	stopRes, err := ExecuteTool(context.Background(), "TaskStop", map[string]any{"taskId": taskID}, "/tmp")
	if err != nil {
		t.Fatalf("TaskStop: %v", err)
	}
	if stopRes.IsError {
		t.Fatalf("TaskStop error: %s", stopRes.Content)
	}

	tasksMu.RLock()
	task := tasks[taskID]
	status := task.Status
	pid := task.PID
	tasksMu.RUnlock()
	if status != "stopped" {
		t.Errorf("status = %q, want stopped", status)
	}

	// The process must actually die (procgroup kill), promptly — not after
	// the sleep finishes. signal 0 probes existence without killing.
	waitForProcessGone(t, pid, 3*time.Second)
}

// waitForProcessGone polls the PID with signal 0 until it no longer exists.
func waitForProcessGone(t *testing.T, pid int, timeout time.Duration) {
	t.Helper()
	if pid <= 0 {
		t.Fatalf("invalid pid %d", pid)
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return // ESRCH: process gone
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d still alive after %s", pid, timeout)
}

// TestBashRunInBackground_OwnerCleanup pins session-end teardown: running
// tasks owned by a session are killed and stamped "stopped"; tasks of other
// owners are untouched.
func TestBashRunInBackground_OwnerCleanup(t *testing.T) {
	clearBashTasks(t)

	ownedCtx := WithBackgroundTaskOwner(context.Background(), "sess-A")
	otherCtx := WithBackgroundTaskOwner(context.Background(), "sess-B")

	resA, err := ExecuteTool(ownedCtx, "Bash", map[string]any{"command": `sh -c "sleep 60"`, "run_in_background": true}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool A: %v", err)
	}
	resB, err := ExecuteTool(otherCtx, "Bash", map[string]any{"command": `sh -c "sleep 60"`, "run_in_background": true}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool B: %v", err)
	}
	idA := extractTaskID(t, resA.Content)
	idB := extractTaskID(t, resB.Content)

	StopBackgroundTasksForOwner("sess-A")

	tasksMu.RLock()
	_, ownedTaskExists := tasks[idA]
	otherTask := tasks[idB]
	statusB := ""
	if otherTask != nil {
		statusB = otherTask.Status
	}
	tasksMu.RUnlock()
	if ownedTaskExists {
		t.Error("owned task should be purged from the registry")
	}
	if statusB != "running" {
		t.Errorf("other-owner task status = %q, want running", statusB)
	}
}

// TestBashRunInBackground_UnsupportedBackend pins the capability guard: a
// BashOperations backend without StartBackground yields a clean tool error.
func TestBashRunInBackground_UnsupportedBackend(t *testing.T) {
	clearBashTasks(t)

	prev := GetBashOperations()
	SetBashOperations(&foregroundOnlyOps{})
	defer SetBashOperations(prev)

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "echo hi",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if !result.IsError {
		t.Fatal("expected IsError for unsupported backend")
	}
	if !strings.Contains(result.Content, "not supported") {
		t.Errorf("error content = %q", result.Content)
	}
}

// foregroundOnlyOps implements BashOperations without the background capability.
type foregroundOnlyOps struct{}

func (f *foregroundOnlyOps) Exec(ctx context.Context, command, cwd string, opts ExecOptions) (*ExecResult, error) {
	return &ExecResult{Stdout: "fg"}, nil
}

// TestBashRunInBackground_NoTaskToolsStillReturnsPath pins the harness-opt-in
// stance: without the Task tools registered, the result still carries the
// output-file path (the model Reads the file instead of TaskGet).
func TestBashRunInBackground_NoTaskToolsStillReturnsPath(t *testing.T) {
	clearBashTasks(t)
	UnregisterTaskTools()     // simulate a harness that did not opt in
	defer RegisterTaskTools() // restore TestMain's registration for later tests

	result, err := ExecuteTool(context.Background(), "Bash", map[string]any{
		"command":           "echo path-check",
		"run_in_background": true,
	}, t.TempDir())
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	outPath := extractOutputPath(t, result.Content)
	if outPath == "" {
		t.Fatal("expected output path in result")
	}
	if strings.Contains(result.Content, "TaskGet") {
		t.Errorf("TaskGet hint must be omitted when Task tools are unregistered: %q", result.Content)
	}
	if !strings.Contains(result.Content, "Read the output file") {
		t.Errorf("expected file-read hint, got %q", result.Content)
	}
}
