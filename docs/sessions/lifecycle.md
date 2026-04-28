---
title: Session Lifecycle
description: Session creation, prompt dispatch, and shutdown.
sidebar_position: 2
---

# Session Lifecycle

Sessions move through a predictable sequence: create, run, stop. The engine manages transitions and emits events at each stage.

## Create (StartSession)

`StartSession(key, config)` initializes a new session:

1. Allocate the session struct with the provided config.
2. Initialize the process registry for extension-spawned subprocesses.
3. Wire the permission engine (default allow-all, or from engine config).
4. Wire telemetry if configured.
5. Load the extension host if `extensionDir` is set in config.
6. Fire `session_start` hook on the extension.
7. Discover capabilities from extensions.
8. Load skills from `~/.ion/skills/` and `.ion/skills/`.
9. Connect MCP servers from engine config.
10. Emit `engine_status` with state `idle`.

If a session with the same key already exists, `StartSession` returns an error.

## Prompt (SendPrompt)

`SendPrompt(key, text, overrides)` dispatches a prompt to the session's backend:

1. If a run is active, queue the prompt (up to 32 pending prompts).
2. Generate a unique request ID.
3. Build `RunOptions` from session config, per-prompt overrides, and engine defaults.
4. Discover context files (ION.md, CLAUDE.md) from the working directory.
5. Fire `context_inject` hook for extension-provided context.
6. Inject git context from the working directory.
7. Fire `before_agent_start` for system prompt injection.
8. Wire extension hooks (tool_call, turn, compaction, permission, file_changed).
9. Wire MCP tools and agent spawner.
10. Emit `engine_status` with state `running`.
11. Call `backend.StartRun()`.

### Per-prompt overrides

Clients can override these fields per prompt without changing the session config:

| Field | Description |
|-------|-------------|
| `Model` | Use a different model for this prompt only |
| `MaxTurns` | Limit tool loop iterations |
| `MaxBudgetUsd` | Cost cap for this run |
| `ExtensionDir` | Load an extension for this prompt (if session has none) |
| `NoExtensions` | Skip extension hooks for this prompt |

### Prompt queue

When a run is active, new prompts enter a FIFO queue. The queue holds up to 32 prompts. Exceeding the limit returns an error to the client.

After a run completes (`handleRunExit`), the manager dequeues the next prompt and dispatches it in a goroutine. This means queued prompts execute sequentially with no gap.

## Run completion (handleRunExit)

When a backend run exits:

1. Clear the session's active request ID.
2. Clear agent state (all sub-agents are done).
3. Store the conversation/session ID returned by the backend.
4. Emit `engine_agent_state` with an empty list (clear agent panel).
5. Emit `engine_status` with state `idle`.
6. If the exit code is non-zero or a signal was received, emit `engine_dead`.
7. Dequeue and dispatch the next pending prompt if one exists.

## Stop (StopSession)

`StopSession(key)` tears down the session:

1. Cancel the active run if one exists.
2. Drop all pending prompts from the queue.
3. Kill child processes (SIGTERM, escalate to SIGKILL after 5 seconds).
4. Stop the tool server if one is running.
5. Fire `session_end` hook on the extension.
6. Dispose the extension host (kills subprocess).
7. Close MCP connections.
8. Flush telemetry.
9. Close the session recorder.
10. Emit `engine_dead`.

## Event flow diagram

```
StartSession
  -> engine_status(idle)

SendPrompt
  -> engine_status(running)
  -> engine_text_delta (streaming)
  -> engine_tool_start / engine_tool_end (tool use)
  -> engine_message_end (usage stats)
  -> engine_status(idle)

StopSession
  -> engine_dead
```

## Error handling

Backend errors during a run emit `engine_error` events. The session remains alive after an error. If the backend process dies (non-zero exit code or signal), the session emits `engine_dead` and the client should consider the session unusable.
