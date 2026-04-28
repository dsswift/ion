---
title: JSON-RPC Protocol
description: Full JSON-RPC 2.0 wire format specification for Ion Engine extension communication.
sidebar_position: 4
---

# JSON-RPC Protocol

Extensions communicate with the engine via JSON-RPC 2.0 over stdin/stdout. Each message is a single JSON object on its own line (NDJSON framing). The engine sends requests to the extension; the extension sends responses back. Extensions can also send notifications and requests to the engine.

## Transport

- **Engine to extension**: writes JSON-RPC messages to the extension's stdin
- **Extension to engine**: writes JSON-RPC messages to stdout
- **Debug output**: write to stderr (forwarded to engine log, never parsed as JSON-RPC)
- **Framing**: one JSON object per line, terminated by `\n`

## Engine-to-extension requests

### `init`

Sent once at startup. The extension must respond with its tool and command registrations.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "init",
  "params": {
    "extensionDir": "/Users/you/.ion/extensions/my-ext",
    "workingDirectory": "/Users/you/project",
    "mcpConfigPath": ""
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "my_tool",
        "description": "Does something useful",
        "parameters": {
          "type": "object",
          "properties": {
            "input": { "type": "string" }
          },
          "required": ["input"]
        }
      }
    ],
    "commands": {
      "my-cmd": { "description": "A slash command" }
    }
  }
}
```

The `tools` array and `commands` object are both optional. Return an empty result (`{}`) or null if the extension registers neither.

### `hook/{hookName}`

Fired when an engine event occurs. The params contain a `_ctx` field with session context, plus hook-specific payload fields merged at the top level.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "hook/before_prompt",
  "params": {
    "_ctx": {
      "cwd": "/Users/you/project",
      "model": { "id": "claude-sonnet-4-6", "contextWindow": 200000 },
      "config": {
        "extensionDir": "/Users/you/.ion/extensions/my-ext",
        "workingDirectory": "/Users/you/project"
      }
    },
    "_payload": "fix the bug"
  }
}
```

For hooks with structured payloads, the payload fields are merged directly into the params object (alongside `_ctx`):

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "hook/tool_call",
  "params": {
    "_ctx": { "cwd": "/Users/you/project" },
    "toolName": "Bash",
    "toolID": "toolu_abc123",
    "input": { "command": "rm -rf /" }
  }
}
```

**Response patterns:**

Five return patterns cover all 55 hooks:

**Void** -- fire-and-forget hooks. Return null.

```json
{ "jsonrpc": "2.0", "id": 5, "result": null }
```

**String override** -- return a `value` field to replace the original value.

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "value": "rewritten prompt" } }
```

**Block** -- return `block: true` to prevent the operation.

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "block": true, "reason": "Dangerous command" } }
```

**Bool cancel** -- return `true` to cancel, `false` or null to proceed.

```json
{ "jsonrpc": "2.0", "id": 5, "result": true }
```

**Content filter** -- return modified content or reject the item.

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "content": "modified content" } }
```

```json
{ "jsonrpc": "2.0", "id": 5, "result": { "reject": true } }
```

### `tool/{toolName}`

Invoked when the LLM calls a registered tool.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "tool/my_tool",
  "params": {
    "_ctx": { "cwd": "/Users/you/project" },
    "input": "hello"
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": { "content": "Tool output text", "isError": false }
}
```

The `content` field is the text returned to the LLM. Set `isError: true` to indicate the tool failed (the LLM will see the error and may retry or adjust).

### `command/{cmdName}`

Invoked when the user runs a slash command.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 15,
  "method": "command/my-cmd",
  "params": {
    "_ctx": { "cwd": "/Users/you/project" },
    "args": "some arguments"
  }
}
```

**Response:**

```json
{ "jsonrpc": "2.0", "id": 15, "result": null }
```

Commands return null. Use `ext/send_message` notifications to send output back to the conversation.

## Extension-to-engine notifications

Notifications are fire-and-forget messages with no `id` field. The engine does not send a response.

### `ext/emit`

Emit an engine event to all connected socket clients.

```json
{
  "jsonrpc": "2.0",
  "method": "ext/emit",
  "params": {
    "type": "engine_notify",
    "message": "Build complete",
    "level": "info"
  }
}
```

The `params` object is an `EngineEvent`. Five engine-recognised types, plus an open slot for harness-defined types:

| Type | Fields | Purpose |
|------|--------|---------|
| `engine_agent_state` | `agents` | Update agent state display |
| `engine_status` | `fields` | Update status bar |
| `engine_working_message` | `message` | Show transient working indicator |
| `engine_notify` | `message`, `level` | User notification |
| `engine_harness_message` | `message`, `source` | Harness-level message |
| (any other string) | (anything) | Custom harness event — passed through verbatim to every connected socket client |

The engine validates payload shape **only** for `engine_agent_state`. All other types are forwarded as-is. Use a unique prefix (`jarvis_*`, `ion-meta_*`, etc.) to avoid colliding with current or future engine events. The desktop bridge has no type-based dispatch, so custom events surface in clients that explicitly subscribe to them and are silently dropped by clients that don't.

### `ext/send_message`

Queue a message to be sent as assistant content. The engine processes this as a follow-up prompt.

```json
{
  "jsonrpc": "2.0",
  "method": "ext/send_message",
  "params": { "text": "Deployment complete. All services healthy." }
}
```

## Extension-to-engine requests

These are bidirectional RPC calls. The extension sends a request with an `id`, and the engine sends a response back. Use these for process management and agent dispatch.

### `ext/register_process`

Register a subprocess spawned by the extension. Enables lifecycle tracking and cleanup.

```json
{
  "jsonrpc": "2.0",
  "id": 100001,
  "method": "ext/register_process",
  "params": { "name": "worker-1", "pid": 54321, "task": "running tests" }
}
```

**Response:** `{"ok": true}`

### `ext/deregister_process`

Remove a registered process.

```json
{
  "jsonrpc": "2.0",
  "id": 100002,
  "method": "ext/deregister_process",
  "params": { "name": "worker-1" }
}
```

**Response:** `{"ok": true}`

### `ext/list_processes`

List all registered processes.

```json
{
  "jsonrpc": "2.0",
  "id": 100003,
  "method": "ext/list_processes",
  "params": {}
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 100003,
  "result": [
    { "name": "worker-1", "pid": 54321, "task": "running tests", "startedAt": "2026-04-22T10:00:00Z" }
  ]
}
```

### `ext/terminate_process`

Terminate a registered process. Sends SIGTERM, then SIGKILL after 5 seconds.

```json
{
  "jsonrpc": "2.0",
  "id": 100004,
  "method": "ext/terminate_process",
  "params": { "name": "worker-1" }
}
```

**Response:** `{"ok": true}`

### `ext/clean_stale_processes`

Remove PID registrations for processes that are no longer alive.

```json
{
  "jsonrpc": "2.0",
  "id": 100005,
  "method": "ext/clean_stale_processes",
  "params": {}
}
```

**Response:** `{"cleaned": 2}`

### `ext/send_prompt`

Queue a fresh prompt on the session's agent loop. The response confirms the prompt was accepted; it does **not** wait for the LLM to finish.

```json
{
  "jsonrpc": "2.0",
  "id": 100008,
  "method": "ext/send_prompt",
  "params": {
    "text": "What should we work on next?",
    "model": "claude-sonnet-4-6"
  }
}
```

`text` is required. `model` is optional; pass `""` (or omit) to use the session default.

**Response:** `{"ok": true}`

JSON-RPC errors:

| Code | Cause |
|------|-------|
| `-32602` | `text` is empty. |
| `-32000` | No active session bound to the context, or `Manager.SendPrompt` returned an error (e.g. queue full). |

**Recursion hazard.** Calling `ext/send_prompt` from inside a `hook/before_prompt` (or other pre-prompt hook) triggers a new run, which fires the same hook again. The engine's prompt queue depth is the only outer bound. Extensions are responsible for their own loop guards.

### `ext/call_tool`

Dispatch a tool call from extension code through the same registry the LLM uses (built-in, MCP, extension-registered). The engine applies the session's permission policy before executing.

```json
{
  "jsonrpc": "2.0",
  "id": 100007,
  "method": "ext/call_tool",
  "params": {
    "name": "Read",
    "input": { "file_path": "/Users/you/project/README.md" }
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 100007,
  "result": {
    "content": "...file contents...",
    "isError": false
  }
}
```

`name` is required. `input` may be omitted or null and is treated as an empty object.

The result mirrors what an LLM-issued tool call would receive. Permission `deny` decisions resolve with `{ content, isError: true }` describing the rule that fired. `ask` decisions auto-deny with the same shape -- extension calls cannot block on user elicitation, so the harness must configure an explicit allow rule for the specific tool to permit it from extension code.

The engine returns a JSON-RPC error (`-32000`) only when the named tool is not registered. Tool-internal failures (file not found, command failed, etc.) resolve with `isError: true` and a content string describing the failure.

The per-tool hooks (`bash_tool_call`, etc.) and `permission_request` are **not** fired on these calls. Both would re-enter the calling extension and create surprising recursion. Audit log entries from the permission engine still fire.

### `ext/dispatch_agent`

Dispatch an engine-native agent. Creates a child session with optional extension loading, system prompt injection, and event streaming. This call blocks until the agent completes.

```json
{
  "jsonrpc": "2.0",
  "id": 100006,
  "method": "ext/dispatch_agent",
  "params": {
    "name": "researcher",
    "task": "Find all uses of deprecated API",
    "model": "claude-sonnet-4-6",
    "extensionDir": "~/.ion/extensions/my-ext",
    "systemPrompt": "You are a research agent.",
    "projectPath": "/Users/you/project"
  }
}
```

**Response:**

```json
{
  "jsonrpc": "2.0",
  "id": 100006,
  "result": {
    "output": "Found 3 uses of deprecated API...",
    "exitCode": 0,
    "elapsed": 12.5
  }
}
```

Only `name` and `task` are required. All other fields are optional.

## Event buffering during hooks

When a hook handler calls `ctx.emit()`, events are **not** sent as notifications immediately. Instead, they are buffered and returned alongside the hook result in the response:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "value": "rewritten prompt",
    "events": [
      { "type": "engine_notify", "message": "Prompt rewritten", "level": "info" }
    ]
  }
}
```

The engine processes buffered events after the hook completes. This ensures event ordering is deterministic: all events from a hook are emitted together, in order, after the hook result is applied.

Outside of hook execution (e.g., during tool execution or command handling), `ctx.emit()` sends events as `ext/emit` notifications immediately.

## Error responses

Use standard JSON-RPC 2.0 error codes:

| Code | Meaning |
|------|---------|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "error": { "code": -32601, "message": "Method not found: hook/unknown_hook" }
}
```

## Timeout

The engine waits up to 30 seconds for each RPC response. If the extension does not respond within this window, the call fails with a timeout error and the engine continues without the extension's result.
