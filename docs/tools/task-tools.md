---
title: Task Tools
description: Optional task management tools for spawning and tracking asynchronous sub-tasks.
sidebar_position: 4
---

# Task Tools

Four optional tools for asynchronous task management. These tools let the LLM spawn background sub-sessions, track their progress, and collect results.

The tasks registry also tracks **background Bash commands** started with the Bash tool's `run_in_background` parameter. Those tasks carry `bash-` IDs, an on-disk output file, and a real process that `TaskStop` kills — see the differences noted per tool below and the Bash section of the [tool reference](reference.md).

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

For background Bash tasks (`bash-` IDs), the response additionally includes the output-file path, the exit code once the process finishes, and a bounded tail of recent output:

```
Task: bash-3-1713800002000
Status: running
Prompt: python -m graphify.watch . --debounce 3
Output file: /Users/me/.ion/tasks/bash-1713800002.out
Recent output:
[watch] rebuilt graph.json (2 files changed)
Duration: 92.1s (running)
```

### Task Statuses

| Status | Meaning |
|--------|---------|
| `running` | Task is still executing |
| `completed` | Task finished successfully (background Bash: exit code 0) |
| `failed` | Task encountered an error (background Bash: non-zero exit code) |
| `stopped` | Task was stopped by TaskStop or killed at session stop (background Bash) |

## TaskStop

Stop a running task.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `taskId` | string | yes | The task ID to stop |

### Behavior

Sets the task status to `stopped` and records the completion time. For background Bash tasks this also kills the process group. Returns an error if the task is not in the `running` state.

### Response

```
Task task-1-1713800000000 stopped.
```

## Task Lifecycle Hooks

The engine fires hooks when tasks are created and completed:

- `task_created` -- fired after a task is spawned. Payload: `TaskLifecycleInfo{TaskID, Name, Status, Extra}`.
- `task_completed` -- fired when a task finishes. Payload: `TaskLifecycleInfo{TaskID, Name, Status, Extra}`.

These hooks are observational. Extensions can use them for logging, notifications, or updating UI state.

Note that `task_created` / `task_completed` are **turn** lifecycle hooks (`TaskID` is `<session-key>-t<turn-number>`). Background shell commands have their own hook — see below.

## Agent dispatch completion

`Agent({ prompt })` dispatches a child asynchronously by default. The tool returns a dispatch ID at once, so parent may continue work or end turn. Engine routes child success, error, or recall back as classified `agent_completion` input; it does not require extension callbacks or polling. A user can steer a live child by dispatch ID through the existing steering surface. Use `wait_for_completion: true` only when current turn must block for terminal child output.

`detached: true` on extension dispatch opts out of automatic parent delivery for genuine fire-and-forget work such as schedule-owned jobs.

## Poll

`Poll({ intent, check_command? })` owns an inference-driven wait-and-recheck loop. The engine runs `check_command` before each attempt and gives its raw output to a detached check agent. The agent requires raw evidence with every verdict, and wakes the parent once with `satisfied`, `failed`, `stuck`, or `exhausted`. Only `advancing` re-arms the next check. `stuck` means the poll cannot decide and returns control to the parent; it does not claim the watched work is wedged.

Use `Poll` for work that needs judgment, such as a deployment rollout, pull-request checks, or another agent's edits. Do not use a bare `sleep` as a timer. `interval_ms`, `deadline_ms`, and `max_attempts` can narrow work but are capped by the engine `poll` configuration.

## Background bash completion

`Bash({ run_in_background: true, notify_on_complete: true })` starts a shell command the session will be told about when it finishes, rather than one the model has to poll with `TaskGet`.

### The outstanding set

A notifying command joins the session's **outstanding set**. The set is session-scoped, not run-scoped: a model can start a command in one turn, keep working, start another in a later turn, and both are still tracked when it finally stops. A command started without `notify_on_complete` never joins the set — nothing is waiting on it. When a notifying command is the only remaining work, the model ends its turn instead of polling or starting a blocking wait; the engine then parks the session and resumes it on completion.

`backgroundTasks.maxOutstandingPerSession` bounds the set. Past the cap a command still runs and still emits its completion event; it simply is not tracked, so a runaway loop cannot park the session on an unbounded pile.

### Correlating tool rows with delivered work

When the engine starts an asynchronous task (background Bash or Agent dispatch), the `engine_tool_end` event and the persisted `SessionMessage` for that tool result carry a `backgroundTaskId` field -- the Bash task ID or Agent dispatch ID. When the task later completes and the engine delivers the result via `engine_background_work_delivered`, each delivered item's `id` matches the originating `backgroundTaskId`. Clients can use this correlation to fold delivered work onto the tool row that started it rather than rendering a standalone group.

### Park, wake, re-park

The cycle the engine runs:

1. The model works, starting notifying commands whenever it wants.
2. It ends its turn. If the outstanding set is non-empty the engine **parks** the run — it exits without completing, emitting `engine_task_suspended` with `awaitingTaskIds`. No tokens are consumed while parked.
3. A command finishes. The engine emits `engine_background_task_complete`, fires `background_task_completed`, drains that command from the set, and **wakes** the session with an injected prompt carrying the result and the still-outstanding list.
4. The woken run either does work the completion unblocked, or ends its turn — and if anything is still outstanding, the engine parks it again.
5. When the last command completes, the set is empty and the next turn boundary completes the run normally.

Wake is per completion, deliberately unlike dispatch's `PendingChildren` (which revives only when every awaited child is done). A finished command may unblock work the model can do while the others still run; withholding its result until the whole set drains would forfeit that.

### Delivery modes

`backgroundTasks.delivery` in `engine.json`:

| Mode | Behavior |
|------|----------|
| `wake` (default) | An idle or parked session is woken: the completion is injected and a run starts. |
| `queue` | The completion is held and delivered with the next run the session starts for any other reason. Nothing runs unattended. |
| `event_only` | The typed event and the hook fire; nothing is injected and no run starts. |

A completion arriving while a run is **already active** is always steered in mid-turn regardless of mode — there is no unattended-run concern when the session is already working.

### `background_task_completed`

Fired for every notifying command that reaches a terminal state, under every delivery mode. Payload: `BackgroundTaskCompletedInfo{TaskID, SessionKey, Command, Status, ExitCode, ElapsedMs, OutputPath, Tail, RemainingTaskIDs}`.

`Status` is `completed` (exit 0), `failed` (non-zero), or `stopped` (killed by `TaskStop` or session teardown before finishing). A stopped command notifies too — otherwise a parked session would wait forever on a process that was killed out from under it.
