package tools

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Agent Tool Tests
// ---------------------------------------------------------------------------

func TestAgentToolNoSpawner(t *testing.T) {
	// Ensure no spawner is set.
	old := agentSpawner
	agentSpawner = nil
	defer func() { agentSpawner = old }()

	result, err := ExecuteTool(context.Background(), "Agent", map[string]any{"prompt": "do something"}, "/tmp")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !result.IsError {
		t.Error("expected error when no spawner configured")
	}
	if !strings.Contains(result.Content, "not available") {
		t.Errorf("expected 'not available' message, got %q", result.Content)
	}
}

func TestAgentToolMissingPrompt(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing prompt")
	}
	if !strings.Contains(result.Content, "prompt is required") {
		t.Errorf("expected prompt required message, got %q", result.Content)
	}
}

func TestAgentToolWithSpawner(t *testing.T) {
	old := agentSpawner
	agentSpawner = func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "agent completed: " + prompt, nil
	}
	defer func() { agentSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{
		"prompt": "test task",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "agent completed: test task") {
		t.Errorf("expected spawner result, got %q", result.Content)
	}
}

func TestAgentToolSpawnerError(t *testing.T) {
	old := agentSpawner
	agentSpawner = func(ctx context.Context, name, prompt, description, cwd, model string) (string, error) {
		return "", fmt.Errorf("spawn failed")
	}
	defer func() { agentSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "Agent", map[string]any{
		"prompt": "test",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error when spawner fails")
	}
	if !strings.Contains(result.Content, "spawn failed") {
		t.Errorf("expected spawn error message, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// LSP Tool Tests
// ---------------------------------------------------------------------------

func TestLspToolNotConfigured(t *testing.T) {
	old := lspManager
	lspManager = nil
	defer func() { lspManager = old }()

	result, _ := ExecuteTool(context.Background(), "LSP", map[string]any{"operation": "hover"}, "/tmp")
	if !result.IsError {
		t.Error("expected error when LSP not configured")
	}
	if !strings.Contains(result.Content, "LSP not configured") {
		t.Errorf("unexpected message: %s", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Task Tool Tests
// ---------------------------------------------------------------------------

func TestTaskToolsNoSpawner(t *testing.T) {
	old := taskSpawner
	taskSpawner = nil
	defer func() { taskSpawner = old }()

	result, _ := ExecuteTool(context.Background(), "TaskCreate", map[string]any{"prompt": "test"}, "/tmp")
	if !result.IsError {
		t.Error("expected error when no task spawner configured")
	}
}

func TestTaskListEmpty(t *testing.T) {
	// Clear tasks for this test.
	tasksMu.Lock()
	saved := tasks
	tasks = make(map[string]*TaskInfo)
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskList", map[string]any{}, "/tmp")
	if result.Content != "No tasks." {
		t.Errorf("expected 'No tasks.', got %q", result.Content)
	}
}

func TestTaskGetNotFound(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{
		"taskId": "task-nonexistent",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for nonexistent task")
	}
	if !strings.Contains(result.Content, "not found") {
		t.Errorf("expected 'not found', got %q", result.Content)
	}
}

func TestTaskGetMissingId(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing taskId")
	}
}

func TestTaskStopNotFound(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{
		"taskId": "task-ghost",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for nonexistent task")
	}
}

func TestTaskStopMissingId(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing taskId")
	}
}

func TestTaskStopAlreadyCompleted(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	now := time.Now()
	tasks = map[string]*TaskInfo{
		"task-done": {
			ID:          "task-done",
			Prompt:      "done task",
			Status:      "completed",
			StartedAt:   now,
			CompletedAt: &now,
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskStop", map[string]any{
		"taskId": "task-done",
	}, "/tmp")
	// Should not error but indicate it's not running.
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "not running") {
		t.Errorf("expected 'not running' message, got %q", result.Content)
	}
}

func TestTaskCreateMissingPrompt(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "TaskCreate", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing prompt")
	}
}

func TestTaskListWithTasks(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	tasks = map[string]*TaskInfo{
		"task-abc": {
			ID:        "task-abc",
			Prompt:    "do something",
			Status:    "running",
			StartedAt: time.Now(),
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskList", map[string]any{}, "/tmp")
	if !strings.Contains(result.Content, "task-abc") {
		t.Errorf("expected task-abc in list, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "running") {
		t.Errorf("expected 'running' status, got %q", result.Content)
	}
}

func TestTaskGetExistingTask(t *testing.T) {
	tasksMu.Lock()
	saved := tasks
	tasks = map[string]*TaskInfo{
		"task-xyz": {
			ID:        "task-xyz",
			Prompt:    "test prompt",
			Status:    "completed",
			Result:    "task result here",
			StartedAt: time.Now(),
		},
	}
	tasksMu.Unlock()
	defer func() {
		tasksMu.Lock()
		tasks = saved
		tasksMu.Unlock()
	}()

	result, _ := ExecuteTool(context.Background(), "TaskGet", map[string]any{
		"taskId": "task-xyz",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "task-xyz") {
		t.Errorf("expected task ID in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "completed") {
		t.Errorf("expected status, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "task result here") {
		t.Errorf("expected result content, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// WebFetch Tests
// ---------------------------------------------------------------------------
