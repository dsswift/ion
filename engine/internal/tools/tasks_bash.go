package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// tasks_bash.go registers background Bash commands (bash.go
// run_in_background) in the shared tasks registry so TaskList / TaskGet /
// TaskStop manage them alongside agent tasks, and so the owning session can
// kill its background processes at stop time.

type backgroundTaskOwnerKey struct{}

// WithBackgroundTaskOwner returns a context carrying the session key that
// owns background tasks started within it. Stamped by the runloop from
// RunConfig.BackgroundTaskOwner; consumed by executeBash so session cleanup
// (StopBackgroundTasksForOwner) can find and kill the session's processes.
func WithBackgroundTaskOwner(ctx context.Context, sessionKey string) context.Context {
	return context.WithValue(ctx, backgroundTaskOwnerKey{}, sessionKey)
}

// BackgroundTaskOwnerFromContext extracts the owning session key, or "".
func BackgroundTaskOwnerFromContext(ctx context.Context) string {
	owner, _ := ctx.Value(backgroundTaskOwnerKey{}).(string) //nolint:errcheck // absent value means no owner
	return owner
}

// startBackgroundBashTask launches the command via the backend's background
// capability and registers it as a Kind=="bash" task. Returns the registered
// TaskInfo (already in the registry) for result rendering.
func startBackgroundBashTask(ctx context.Context, ops BackgroundBashOperations, command, cwd string, opts ExecOptions) (*TaskInfo, error) {
	handle, err := ops.StartBackground(ctx, command, cwd, opts)
	if err != nil {
		return nil, err
	}

	n := taskCounter.Add(1)
	taskID := fmt.Sprintf("bash-%d-%d", n, time.Now().UnixMilli())
	owner := BackgroundTaskOwnerFromContext(ctx)

	info := &TaskInfo{
		ID:         taskID,
		Prompt:     command,
		Status:     "running",
		StartedAt:  time.Now(),
		Kind:       "bash",
		OutputPath: handle.OutputPath,
		Owner:      owner,
		PID:        handle.PID,
		stop:       handle.Stop,
		tail:       handle.Tail,
	}

	tasksMu.Lock()
	tasks[taskID] = info
	tasksMu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task registered", map[string]any{
		"task_id": taskID, "pid": handle.PID, "path": handle.OutputPath, "session_id": owner,
	})

	// Stamp terminal status when the process exits. TaskStop / owner cleanup
	// set status "stopped" first; don't overwrite a stop with "completed".
	go func() {
		<-handle.Done
		now := time.Now()
		tasksMu.Lock()
		defer tasksMu.Unlock()
		if info.Status != "running" {
			return
		}
		info.CompletedAt = &now
		info.ExitCode = handle.ExitCode()
		if info.ExitCode == 0 {
			info.Status = "completed"
		} else {
			info.Status = "failed"
			info.Error = fmt.Sprintf("exit code %d", info.ExitCode)
		}
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task finished", map[string]any{
			"task_id": info.ID, "status": info.Status, "exit_code": info.ExitCode,
		})
	}()

	return info, nil
}

// StopBackgroundTasksForOwner kills every running background bash task owned
// by the given session key and marks it "stopped". Called from the session
// layer at StopSession so a session's background processes never outlive it.
func StopBackgroundTasksForOwner(sessionKey string) {
	if sessionKey == "" {
		return
	}
	now := time.Now()
	var stopped []string

	tasksMu.Lock()
	for _, t := range tasks {
		if t.Kind != "bash" || t.Owner != sessionKey || t.Status != "running" {
			continue
		}
		t.Status = "stopped"
		t.CompletedAt = &now
		if t.stop != nil {
			// stop() signals the process group and returns immediately (no
			// wait), so holding tasksMu here is fine. The Done-watcher
			// goroutine then sees a non-"running" status and leaves the
			// "stopped" stamp in place.
			t.stop()
		}
		stopped = append(stopped, t.ID)
	}
	tasksMu.Unlock()

	if len(stopped) > 0 {
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "background tasks stopped with session", map[string]any{
			"session_id": sessionKey, "count": len(stopped), "model": stopped,
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "tools.bash", "no background tasks to stop for session", map[string]any{"session_id": sessionKey})
	}
}
