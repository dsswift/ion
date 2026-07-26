package tools

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// tasks_bash.go registers background Bash commands (bash.go
// run_in_background) in the shared tasks registry so TaskList / TaskGet /
// TaskStop manage them alongside agent tasks, and so the owning session can
// kill its background processes at stop time.

type backgroundTaskOwnerKey struct{}

type outstandingRegistrarKey struct{}

// OutstandingRegistrar adds a notifying background task to the owning
// session's outstanding set. Session-scoped rather than run-scoped: the set
// must survive across runs, because a model may start tasks over several turns
// and several runs before the session finally holds for them.
type OutstandingRegistrar func(taskID, command string)

// WithOutstandingRegistrar returns a context carrying the registrar the Bash
// tool calls when notify_on_complete is set. Stamped by the runloop from
// RunConfig.RegisterOutstandingBackgroundTask.
func WithOutstandingRegistrar(ctx context.Context, fn OutstandingRegistrar) context.Context {
	return context.WithValue(ctx, outstandingRegistrarKey{}, fn)
}

// OutstandingRegistrarFromContext extracts the registrar, or nil.
func OutstandingRegistrarFromContext(ctx context.Context) OutstandingRegistrar {
	fn, _ := ctx.Value(outstandingRegistrarKey{}).(OutstandingRegistrar) //nolint:errcheck // absent value means no registrar
	return fn
}

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

// TaskCompletion is the terminal report for a Kind=="bash" task that was
// started with notify_on_complete. It carries everything a consumer needs to
// act on the completion without reaching back into this package's registry.
type TaskCompletion struct {
	// TaskID is the tasks-registry ID ("bash-<n>-<millis>").
	TaskID string
	// Owner is the session key that started the task (may be "" when the
	// task was started outside a session-owned run).
	Owner string
	// Command is the shell command that ran, so a consumer can describe the
	// task without a second registry lookup.
	Command string
	// Status is the terminal status: "completed", "failed", or "stopped".
	Status string
	// ExitCode is the process exit code. Zero for "stopped" tasks that were
	// killed before reporting one.
	ExitCode int
	// ElapsedMs is wall-clock milliseconds from start to terminal transition.
	ElapsedMs int64
	// OutputPath is the on-disk file holding the full interleaved output.
	OutputPath string
	// Tail is the bounded in-memory tail of the command's output.
	Tail string
}

// TaskCompletionNotifier is invoked once per notifying background task when it
// reaches a terminal state.
type TaskCompletionNotifier func(TaskCompletion)

var (
	taskNotifierMu sync.RWMutex
	taskNotifier   TaskCompletionNotifier
)

// SetTaskCompletionNotifier installs the callback invoked when a notifying
// background bash task terminates. Follows the SetTaskSpawner /
// SetBashOperations seam pattern: the session layer installs a notifier at
// construction, which keeps this package free of a session import. Passing nil
// disables notification (the tasks still run and are still registered).
func SetTaskCompletionNotifier(fn TaskCompletionNotifier) {
	taskNotifierMu.Lock()
	defer taskNotifierMu.Unlock()
	taskNotifier = fn
}

// notifyTaskCompletion delivers a terminal report to the installed notifier.
// Called from the Done-watcher goroutine and from StopBackgroundTasksForOwner,
// always OUTSIDE tasksMu: the notifier reaches into the session layer, and
// holding the registry lock across that call would invert the lock order
// against TaskGet/TaskList readers.
func notifyTaskCompletion(c TaskCompletion) {
	taskNotifierMu.RLock()
	fn := taskNotifier
	taskNotifierMu.RUnlock()

	if fn == nil {
		utils.LogWithFields(utils.LevelWarn, "tools.bash", "background task completion not delivered: no notifier installed", map[string]any{
			"task_id": c.TaskID, "session_id": c.Owner, "status": c.Status,
		})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task completion notifying session", map[string]any{
		"task_id": c.TaskID, "session_id": c.Owner, "status": c.Status, "exit_code": c.ExitCode, "duration_ms": c.ElapsedMs,
	})
	fn(c)
}

// completionFor builds a TaskCompletion from a registry entry. Caller must
// hold tasksMu (it reads info fields); the returned value is a snapshot safe
// to hand to the notifier after the lock is dropped.
func completionFor(info *TaskInfo, handle *BackgroundHandle) TaskCompletion {
	elapsed := int64(0)
	if info.CompletedAt != nil {
		elapsed = info.CompletedAt.Sub(info.StartedAt).Milliseconds()
	} else {
		elapsed = time.Since(info.StartedAt).Milliseconds()
	}
	tail := ""
	if handle != nil {
		tail = handle.Tail()
	} else if info.tail != nil {
		tail = info.tail()
	}
	return TaskCompletion{
		TaskID:     info.ID,
		Owner:      info.Owner,
		Command:    info.Prompt,
		Status:     info.Status,
		ExitCode:   info.ExitCode,
		ElapsedMs:  elapsed,
		OutputPath: info.OutputPath,
		Tail:       tail,
	}
}

// startBackgroundBashTask launches the command via the backend's background
// capability and registers it as a Kind=="bash" task. Returns the registered
// TaskInfo (already in the registry) for result rendering. notifyOnComplete
// marks the task for terminal-state notification (see notifyTaskCompletion).
func startBackgroundBashTask(ctx context.Context, ops BackgroundBashOperations, command, cwd string, opts ExecOptions, notifyOnComplete bool) (*TaskInfo, error) {
	handle, err := ops.StartBackground(ctx, command, cwd, opts)
	if err != nil {
		return nil, err
	}

	n := taskCounter.Add(1)
	taskID := fmt.Sprintf("bash-%d-%d", n, time.Now().UnixMilli())
	owner := BackgroundTaskOwnerFromContext(ctx)

	info := &TaskInfo{
		ID:               taskID,
		Prompt:           command,
		Status:           "running",
		StartedAt:        time.Now(),
		Kind:             "bash",
		OutputPath:       handle.OutputPath,
		Owner:            owner,
		PID:              handle.PID,
		NotifyOnComplete: notifyOnComplete,
		stop:             handle.Stop,
		tail:             handle.Tail,
	}

	tasksMu.Lock()
	tasks[taskID] = info
	tasksMu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task registered", map[string]any{
		"task_id": taskID, "pid": handle.PID, "path": handle.OutputPath, "session_id": owner, "notify_on_complete": notifyOnComplete,
	})

	// Stamp terminal status when the process exits. TaskStop / owner cleanup
	// set status "stopped" first; don't overwrite a stop with "completed".
	go func() {
		<-handle.Done
		now := time.Now()
		tasksMu.Lock()
		if info.Status != "running" {
			// Already terminal (TaskStop or owner cleanup won the race). That
			// path owns the notification, so this goroutine must not send a
			// second one — a parked session would otherwise be woken twice
			// for one task.
			tasksMu.Unlock()
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
		notify := info.NotifyOnComplete
		completion := completionFor(info, handle)
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "background task finished", map[string]any{
			"task_id": info.ID, "status": info.Status, "exit_code": info.ExitCode, "notify_on_complete": notify,
		})
		tasksMu.Unlock()

		if notify {
			notifyTaskCompletion(completion)
		}
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
	var completions []TaskCompletion

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
		if t.NotifyOnComplete {
			// The Done-watcher bails out on a non-"running" status, so this
			// path owns the notification for tasks it stops. Without it a
			// parked orchestrator would wait forever on a task that was
			// killed out from under it.
			completions = append(completions, completionFor(t, nil))
		}
		stopped = append(stopped, t.ID)
	}
	tasksMu.Unlock()

	// Notify outside the registry lock (see notifyTaskCompletion).
	for _, c := range completions {
		notifyTaskCompletion(c)
	}

	if len(stopped) > 0 {
		utils.LogWithFields(utils.LevelInfo, "tools.bash", "background tasks stopped with session", map[string]any{
			"session_id": sessionKey, "count": len(stopped), "model": stopped, "notified": len(completions),
		})
	} else {
		utils.LogWithFields(utils.LevelDebug, "tools.bash", "no background tasks to stop for session", map[string]any{"session_id": sessionKey})
	}
}
