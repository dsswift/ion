package tools

import (
	"sort"
	"time"
)

// BackgroundTaskState is a safe snapshot of one live session-owned Bash task.
type BackgroundTaskState struct {
	TaskID           string
	ToolID           string
	Command          string
	StartedAt        time.Time
	NotifyOnComplete bool
}

// BackgroundTasksForOwner returns live Bash tasks for one session, oldest first.
func BackgroundTasksForOwner(owner string) []BackgroundTaskState {
	tasksMu.RLock()
	defer tasksMu.RUnlock()
	var result []BackgroundTaskState
	for _, task := range tasks {
		if task.Kind != "bash" || task.Owner != owner || task.Status != "running" {
			continue
		}
		result = append(result, BackgroundTaskState{TaskID: task.ID, ToolID: task.ToolID, Command: task.Prompt, StartedAt: task.StartedAt, NotifyOnComplete: task.NotifyOnComplete})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].StartedAt.Before(result[j].StartedAt) })
	return result
}

// StopBackgroundTaskForOwner stops exactly one live Bash task owned by owner.
// It returns a stable outcome for client commands without exposing another
// session's process details.
func StopBackgroundTaskForOwner(owner, taskID string) string {
	tasksMu.Lock()
	task, ok := tasks[taskID]
	if !ok {
		tasksMu.Unlock()
		return "not_found"
	}
	if task.Kind != "bash" || task.Owner != owner {
		tasksMu.Unlock()
		return "ownership_mismatch"
	}
	if task.Status != "running" {
		tasksMu.Unlock()
		return "already_terminal"
	}
	now := time.Now()
	task.Status = "stopped"
	task.CompletedAt = &now
	stop := task.stop
	var completion *TaskCompletion
	if task.NotifyOnComplete {
		c := completionFor(task, nil)
		completion = &c
	}
	tasksMu.Unlock()
	if stop != nil {
		stop()
	}
	if completion != nil {
		notifyTaskCompletion(*completion)
	}
	terminal := TaskCompletion{TaskID: task.ID, Owner: task.Owner, Command: task.Prompt, Status: "stopped", ExitCode: task.ExitCode, ElapsedMs: time.Since(task.StartedAt).Milliseconds(), OutputPath: task.OutputPath}
	notifyBackgroundTaskLifecycle(terminal, true)
	return "stopped"
}
