package tools

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TaskInfo tracks the state of a spawned sub-task.
type TaskInfo struct {
	ID          string
	Prompt      string
	Status      string // "running", "completed", "failed", "stopped"
	Result      string
	Error       string
	StartedAt   time.Time
	CompletedAt *time.Time
}

// TaskSpawner is a function that creates a sub-session for a task.
// Returns a taskId and a channel that delivers the final result.
type TaskSpawner func(prompt string, parentSessionKey string) (taskID string, result <-chan string, err error)

var (
	tasks       = make(map[string]*TaskInfo)
	tasksMu     sync.RWMutex
	taskCounter atomic.Int64
	taskSpawner TaskSpawner
)

// SetTaskSpawner configures the function used by TaskCreate to spawn sub-sessions.
func SetTaskSpawner(fn TaskSpawner) {
	taskSpawner = fn
}

// TaskCreateTool returns a ToolDef that creates asynchronous sub-tasks.
func TaskCreateTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "TaskCreate",
		Description: "Create an asynchronous sub-task that runs in a separate session. Returns a task ID for tracking. Use TaskGet to check results.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"prompt":      map[string]any{"type": "string", "description": "The prompt/instruction for the sub-task"},
				"description": map[string]any{"type": "string", "description": "Short description of what this task does"},
			},
			"required": []string{"prompt"},
		},
		Execute: executeTaskCreate,
	}
}

func executeTaskCreate(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: TaskCreate cancelled.", IsError: true}, nil
	}
	prompt, _ := input["prompt"].(string)
	if prompt == "" {
		return &types.ToolResult{Content: "Error: prompt is required", IsError: true}, nil
	}
	description := stringFromInput(input, "description", "")

	if taskSpawner == nil {
		return &types.ToolResult{
			Content: "Task spawning not available in current configuration",
			IsError: true,
		}, nil
	}

	n := taskCounter.Add(1)
	taskID := fmt.Sprintf("task-%d-%d", n, time.Now().UnixMilli())

	info := &TaskInfo{
		ID:        taskID,
		Prompt:    prompt,
		Status:    "running",
		StartedAt: time.Now(),
	}

	tasksMu.Lock()
	tasks[taskID] = info
	tasksMu.Unlock()

	_, resultCh, err := taskSpawner(prompt, cwd)
	if err != nil {
		info.Status = "failed"
		info.Error = err.Error()
		return &types.ToolResult{Content: fmt.Sprintf("Failed to create task: %s", err), IsError: true}, nil
	}

	// Run in background goroutine.
	go func() {
		result, ok := <-resultCh
		now := time.Now()
		tasksMu.Lock()
		defer tasksMu.Unlock()
		info.CompletedAt = &now
		if ok {
			info.Status = "completed"
			info.Result = result
		} else {
			info.Status = "failed"
			info.Error = "task channel closed without result"
		}
	}()

	desc := description
	if desc == "" {
		desc = prompt
		if len(desc) > 100 {
			desc = desc[:100]
		}
	}

	return &types.ToolResult{
		Content: fmt.Sprintf("Task created: %s\nDescription: %s\nUse TaskGet to check status.", taskID, desc),
	}, nil
}

// TaskListTool returns a ToolDef that lists all active and recently completed tasks.
func TaskListTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "TaskList",
		Description: "List all active and recently completed tasks.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		Execute: executeTaskList,
	}
}

func executeTaskList(ctx context.Context, _ map[string]any, _ string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: TaskList cancelled.", IsError: true}, nil
	}
	tasksMu.RLock()
	defer tasksMu.RUnlock()

	if len(tasks) == 0 {
		return &types.ToolResult{Content: "No tasks."}, nil
	}

	var sb strings.Builder
	for _, t := range tasks {
		var duration string
		if t.CompletedAt != nil {
			duration = fmt.Sprintf("%.1fs", t.CompletedAt.Sub(t.StartedAt).Seconds())
		} else {
			duration = fmt.Sprintf("%.1fs (running)", time.Since(t.StartedAt).Seconds())
		}

		promptPreview := t.Prompt
		if len(promptPreview) > 80 {
			promptPreview = promptPreview[:80]
		}

		fmt.Fprintf(&sb, "- %s: %s (%s) -- %s\n", t.ID, t.Status, duration, promptPreview)
	}

	return &types.ToolResult{Content: strings.TrimRight(sb.String(), "\n")}, nil
}

// TaskGetTool returns a ToolDef that gets the status and result of a task by ID.
func TaskGetTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "TaskGet",
		Description: "Get the status and result of a task by ID.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId": map[string]any{"type": "string", "description": "The task ID returned by TaskCreate"},
			},
			"required": []string{"taskId"},
		},
		Execute: executeTaskGet,
	}
}

func executeTaskGet(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: TaskGet cancelled.", IsError: true}, nil
	}
	taskID, _ := input["taskId"].(string)
	if taskID == "" {
		return &types.ToolResult{Content: "Error: taskId is required", IsError: true}, nil
	}

	tasksMu.RLock()
	task, ok := tasks[taskID]
	tasksMu.RUnlock()

	if !ok {
		return &types.ToolResult{Content: fmt.Sprintf("Task not found: %s", taskID), IsError: true}, nil
	}

	promptPreview := task.Prompt
	if len(promptPreview) > 200 {
		promptPreview = promptPreview[:200]
	}

	parts := []string{
		fmt.Sprintf("Task: %s", task.ID),
		fmt.Sprintf("Status: %s", task.Status),
		fmt.Sprintf("Prompt: %s", promptPreview),
	}

	if task.Result != "" {
		parts = append(parts, fmt.Sprintf("Result:\n%s", task.Result))
	}
	if task.Error != "" {
		parts = append(parts, fmt.Sprintf("Error: %s", task.Error))
	}

	var duration string
	if task.CompletedAt != nil {
		duration = fmt.Sprintf("%.1fs", task.CompletedAt.Sub(task.StartedAt).Seconds())
	} else {
		duration = fmt.Sprintf("%.1fs (running)", time.Since(task.StartedAt).Seconds())
	}
	parts = append(parts, fmt.Sprintf("Duration: %s", duration))

	return &types.ToolResult{Content: strings.Join(parts, "\n")}, nil
}

// TaskStopTool returns a ToolDef that stops a running task.
func TaskStopTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "TaskStop",
		Description: "Stop a running task.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"taskId": map[string]any{"type": "string", "description": "The task ID to stop"},
			},
			"required": []string{"taskId"},
		},
		Execute: executeTaskStop,
	}
}

func executeTaskStop(ctx context.Context, input map[string]any, _ string) (*types.ToolResult, error) {
	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: TaskStop cancelled.", IsError: true}, nil
	}
	taskID, _ := input["taskId"].(string)
	if taskID == "" {
		return &types.ToolResult{Content: "Error: taskId is required", IsError: true}, nil
	}

	tasksMu.Lock()
	task, ok := tasks[taskID]
	tasksMu.Unlock()

	if !ok {
		return &types.ToolResult{Content: fmt.Sprintf("Task not found: %s", taskID), IsError: true}, nil
	}

	if task.Status != "running" {
		return &types.ToolResult{
			Content: fmt.Sprintf("Task %s is not running (status: %s)", taskID, task.Status),
		}, nil
	}

	now := time.Now()
	task.Status = "stopped"
	task.CompletedAt = &now

	return &types.ToolResult{Content: fmt.Sprintf("Task %s stopped.", taskID)}, nil
}
