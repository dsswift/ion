---
title: Normalized Events
description: Simplified event types for client consumption.
sidebar_position: 4
---

# Normalized Events

Normalized events are a simplified, canonical representation of the raw engine event stream. The normalizer collapses the various raw event types (system, stream_event, assistant, result, rate_limit_event, permission_request, user) into 15 flat event types that are easier for clients to consume.

Each normalized event is a JSON object with a `type` field as the discriminator.

```json
{"type":"text_chunk","text":"Hello, world!"}
```

## Event Reference

### session_init

Emitted once when a session initializes. Carries session metadata.

| Field        | Type           | Description                    |
|--------------|----------------|--------------------------------|
| `type`       | `"session_init"` | Event type                   |
| `sessionId`  | string         | Engine session ID              |
| `tools`      | string[]       | Registered tool names          |
| `model`      | string         | Active model name              |
| `mcpServers` | McpServerInfo[]| MCP server status              |
| `skills`     | string[]       | Loaded skill names             |
| `version`    | string         | Engine version                 |
| `isWarmup`   | boolean        | True if this is a warmup init  |

**Produced from:** `InitEvent` (type `"system"`, subtype `"init"`)

---

### text_chunk

A chunk of streamed text from the assistant.

| Field  | Type           | Description       |
|--------|----------------|-------------------|
| `type` | `"text_chunk"` | Event type        |
| `text` | string         | Text content      |

**Produced from:** `StreamEvent` with sub-event type `content_block_delta` and delta type `text_delta`

---

### tool_call

Signals the start of a tool invocation.

| Field      | Type          | Description                  |
|------------|---------------|------------------------------|
| `type`     | `"tool_call"` | Event type                   |
| `toolName` | string        | Name of the tool             |
| `toolId`   | string        | Tool use ID                  |
| `index`    | number        | Content block index          |

**Produced from:** `StreamEvent` with sub-event type `content_block_start` and content block type `tool_use`

---

### tool_call_update

Incremental input data for an in-progress tool call.

| Field          | Type                 | Description                |
|----------------|----------------------|----------------------------|
| `type`         | `"tool_call_update"` | Event type                 |
| `toolId`       | string               | Tool use ID                |
| `partialInput` | string               | Partial JSON input string  |

**Produced from:** `StreamEvent` with sub-event type `content_block_delta` and delta type `input_json_delta`

---

### tool_call_complete

Signals that tool input streaming is finished for a content block.

| Field   | Type                   | Description        |
|---------|------------------------|--------------------|
| `type`  | `"tool_call_complete"` | Event type         |
| `index` | number                 | Content block index|

**Produced from:** `StreamEvent` with sub-event type `content_block_stop`

---

### tool_result

The output of a tool execution.

| Field     | Type            | Description                      |
|-----------|-----------------|----------------------------------|
| `type`    | `"tool_result"` | Event type                       |
| `toolId`  | string          | Tool use ID                      |
| `content` | string          | Tool output text                 |
| `isError` | boolean         | `true` if the tool failed        |

**Produced from:** User-type events containing `tool_result` content blocks

---

### task_update

An updated assistant message mid-stream.

| Field     | Type            | Description                             |
|-----------|-----------------|-----------------------------------------|
| `type`    | `"task_update"` | Event type                              |
| `message` | AssistantMessagePayload | The complete message so far     |

**Produced from:** `AssistantEvent`

---

### task_complete

Signals the end of an engine run.

| Field               | Type               | Description                   |
|---------------------|--------------------|-------------------------------|
| `type`              | `"task_complete"`  | Event type                    |
| `result`            | string             | Final result text             |
| `costUsd`           | number             | Total run cost in USD         |
| `durationMs`        | number             | Run duration in milliseconds  |
| `numTurns`          | number             | Number of LLM turns           |
| `usage`             | UsageData          | Cumulative token usage        |
| `sessionId`         | string             | Engine session ID             |
| `permissionDenials` | PermissionDenial[] | Denied tool calls             |

**Produced from:** `ResultEvent` (non-error)

---

### error

An error occurred during the run.

| Field          | Type      | Description                        |
|----------------|-----------|------------------------------------|
| `type`         | `"error"` | Event type                         |
| `message`      | string    | Error description                  |
| `isError`      | boolean   | Always `true`                      |
| `sessionId`    | string    | Engine session ID                  |
| `errorCode`    | string    | Machine-readable error code        |
| `retryable`    | boolean   | Whether the client can retry       |
| `retryAfterMs` | number    | Suggested retry delay              |
| `httpStatus`   | number    | HTTP status code from the provider |

**Produced from:** `ResultEvent` (error)

---

### session_dead

The backend process exited unexpectedly.

| Field        | Type           | Description                       |
|--------------|----------------|-----------------------------------|
| `type`       | `"session_dead"` | Event type                      |
| `exitCode`   | number or null | Process exit code                 |
| `signal`     | string or null | Signal that killed the process    |
| `stderrTail` | string[]       | Last lines of stderr              |

---

### rate_limit

A rate limit was hit.

| Field           | Type           | Description                     |
|-----------------|----------------|---------------------------------|
| `type`          | `"rate_limit"` | Event type                      |
| `status`        | string         | Rate limit status               |
| `resetsAt`      | number         | Unix timestamp when limit resets|
| `rateLimitType` | string         | Type of rate limit              |

**Produced from:** `RateLimitEvent`

---

### usage

A standalone token usage update, typically from the `message_start` sub-event when cache token counts are available.

| Field   | Type        | Description         |
|---------|-------------|---------------------|
| `type`  | `"usage"`   | Event type          |
| `usage` | UsageData   | Token usage data    |

**Produced from:** `StreamEvent` with sub-event type `message_start` (when cache tokens are present)

---

### permission_request

Requests user approval for a tool call.

| Field             | Type            | Description                  |
|-------------------|-----------------|------------------------------|
| `type`            | `"permission_request"` | Event type            |
| `questionId`      | string          | Unique ID for this request   |
| `toolName`        | string          | Tool name                    |
| `toolDescription` | string          | Tool description             |
| `toolInput`       | object          | Tool input parameters        |
| `options`         | PermissionOpt[] | Available response options   |

**Produced from:** `PermissionEvent`

---

### plan_mode_changed

The session entered or exited plan mode.

| Field          | Type                  | Description                   |
|----------------|-----------------------|-------------------------------|
| `type`         | `"plan_mode_changed"` | Event type                    |
| `enabled`      | boolean               | Whether plan mode is active   |
| `planFilePath` | string                | Path to the plan file         |

---

### stream_reset

Signals that a retry is about to occur. Clients should discard any partial assistant text from the previous attempt.

| Field  | Type             | Description |
|--------|------------------|-------------|
| `type` | `"stream_reset"` | Event type  |

No additional fields.

---

## Normalization Pipeline

The normalizer processes raw events by inspecting the top-level `type` field:

| Raw `type`           | Normalized output                                    |
|----------------------|------------------------------------------------------|
| `system` (init)      | `session_init`                                       |
| `stream_event`       | `text_chunk`, `tool_call`, `tool_call_update`, `tool_call_complete`, `usage` |
| `assistant`          | `task_update`                                        |
| `result` (success)   | `task_complete`                                      |
| `result` (error)     | `error`                                              |
| `rate_limit_event`   | `rate_limit`                                         |
| `permission_request` | `permission_request`                                 |
| `user`               | `tool_result` (zero or more)                         |

A single raw event may produce zero or more normalized events. For example, a `stream_event` of sub-type `message_stop` produces no normalized output.
