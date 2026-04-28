---
title: Task Tools
description: Optional task management tools for spawning and tracking asynchronous sub-tasks.
sidebar_position: 4
---

# Task Tools

Four optional tools for asynchronous task management. These tools let the LLM spawn background sub-sessions, track their progress, and collect results.

## Enabling Task Tools

Task tools are not registered by default. The harness must opt in:

```go
import "github.com/dsswift/ion/engine/internal/tools"

// Register all four task tools
tools.RegisterTaskTools()

// Remove them later if needed
tools.UnregisterTaskTools()
```

A `TaskSpawner` function must also be configured for `TaskCreate` to work:

```go
tools.SetTaskSpawner(func(prompt string, parentSessionKey string) (taskID string, result <-chan string, err error) {
    // Create a sub-session, return a channel that delivers the final result
})
```

Without a configured spawner, `TaskCreate` returns an error: "Task spawning not available in current configuration."

## TaskCreate

Create an asynchronous sub-task that runs in a separate session.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `prompt` | string | yes | The prompt/instruction for the sub-task |
| `description` | string | no | Short description of what this task does |

### Behavior

1. Generates a unique task ID (e.g. `task-1-1713800000000`).
2. Calls the configured `TaskSpawner` to create a sub-session.
3. Starts a background goroutine that waits for the result.
4. Returns immediately with the task ID.

### Response

```
Task created: task-1-1713800000000
Description: Refactor the auth module
Use TaskGet to check status.
```

## TaskList

List all active and recently completed tasks.

### Parameters

None.

### Response

Returns a summary of each task with ID, status, duration, and prompt preview:

```
- task-1-1713800000000: running (12.3s running) -- Refactor the auth module
- task-2-1713800001000: completed (5.2s) -- Write unit tests for the parser
```

Returns "No tasks." when the task list is empty.

## TaskGet

Get the status and result of a task by ID.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The task ID returned by TaskCreate |

### Response

```
Task: task-1-1713800000000
Status: completed
Prompt: Refactor the auth module
Result:
Refactored auth module into three files...
Duration: 45.2s
```

### Task Statuses

| Status | Meaning |
|--------|---------|
| `running` | Task is still executing |
| `completed` | Task finished successfully |
| `failed` | Task encountered an error |
| `stopped` | Task was stopped by TaskStop |

## TaskStop

Stop a running task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The task ID to stop |

### Behavior

Sets the task status to `stopped` and records the completion time. Returns an error if the task is not in the `running` state.

### Response

```
Task task-1-1713800000000 stopped.
```

## Task Lifecycle Hooks

The engine fires hooks when tasks are created and completed:

- `task_created` -- fired after a task is spawned. Payload: `TaskLifecycleInfo{TaskID, Name, Status, Extra}`.
- `task_completed` -- fired when a task finishes. Payload: `TaskLifecycleInfo{TaskID, Name, Status, Extra}`.

These hooks are observational. Extensions can use them for logging, notifications, or updating UI state.
