---
title: Server Events
description: Event types broadcast by the Ion Engine to connected clients.
sidebar_position: 3
---

# Server Events

The engine sends three types of server messages. All are NDJSON lines.

## Message Types

### ServerEvent

Broadcast to all connected clients when a session emits an event.

```json
{"key":"abc-123","event":{...}}
```

| Field   | Type   | Description                                     |
|---------|--------|-------------------------------------------------|
| `key`   | string | Session key that produced the event             |
| `event` | object | Raw engine event (see event types below)        |

### ServerResult

Sent to the requesting client in response to a command that included a `requestId`.

```json
{"cmd":"result","requestId":"r1","ok":true,"data":{...}}
```

| Field       | Type    | Description                                      |
|-------------|---------|--------------------------------------------------|
| `cmd`       | string  | Always `"result"`                                |
| `requestId` | string  | Matches the client's `requestId`                 |
| `ok`        | boolean | `true` if the command succeeded                  |
| `error`     | string  | Error message (present when `ok` is `false`)     |
| `data`      | any     | Response payload (command-specific)              |
| `newKey`    | string  | New session key (only for `fork_session`)        |

### ServerSessionList

Sent in response to `list_sessions` when no `requestId` is provided.

```json
{"cmd":"session_list","sessions":[{"key":"s1","hasActiveRun":true,"toolCount":14}]}
```

| Field      | Type          | Description                |
|------------|---------------|----------------------------|
| `cmd`      | string        | Always `"session_list"`    |
| `sessions` | SessionInfo[] | Array of active sessions   |

---

## Raw Engine Events

The `event` field inside a `ServerEvent` is a raw engine event. Events are discriminated by their `type` field. There are two categories: **stream events** (from the LLM provider) and **engine events** (from the engine itself).

### Stream Events

These events mirror the Claude API's server-sent event stream.

#### InitEvent

Emitted once when a session initializes.

| Field               | Type           | Description                         |
|---------------------|----------------|-------------------------------------|
| `type`              | `"system"`     | Event type                          |
| `subtype`           | `"init"`       | Event subtype                       |
| `session_id`        | string         | Engine session ID                   |
| `cwd`               | string         | Working directory                   |
| `tools`             | string[]       | Registered tool names               |
| `mcp_servers`       | McpServerInfo[]| MCP server connection status        |
| `model`             | string         | Active model name                   |
| `permissionMode`    | string         | Permission mode                     |
| `agents`            | string[]       | Registered agent names              |
| `skills`            | string[]       | Loaded skill names                  |
| `plugins`           | string[]       | Loaded plugin names                 |
| `claude_code_version` | string       | Engine version string               |
| `fast_mode_state`   | string         | Fast mode state                     |
| `uuid`              | string         | Event UUID                          |

**McpServerInfo:**

| Field    | Type   | Description           |
|----------|--------|-----------------------|
| `name`   | string | Server name           |
| `status` | string | Connection status     |

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "sess-001",
  "cwd": "/home/user/project",
  "tools": ["Read", "Write", "Edit", "Bash"],
  "mcp_servers": [],
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "agents": [],
  "skills": [],
  "plugins": [],
  "claude_code_version": "1.0.0",
  "fast_mode_state": "",
  "uuid": "evt-001"
}
```

#### StreamEvent

Wraps sub-events from the Claude API's streaming response.

| Field               | Type            | Description                           |
|---------------------|-----------------|---------------------------------------|
| `type`              | `"stream_event"` | Event type                          |
| `event`             | StreamSubEvent  | The streaming sub-event               |
| `session_id`        | string          | Engine session ID                     |
| `parent_tool_use_id`| string or null  | Tool use ID if inside a tool call     |
| `uuid`              | string          | Event UUID                            |

**StreamSubEvent** is discriminated on its own `type` field:

| Sub-event Type         | Key Fields                                      |
|------------------------|-------------------------------------------------|
| `message_start`        | `message` (AssistantMessagePayload with usage)  |
| `content_block_start`  | `index`, `content_block` (type, id, name)       |
| `content_block_delta`  | `index`, `delta` (type, text or partial_json)   |
| `content_block_stop`   | `index`                                         |
| `message_delta`        | `stop_reason`, `usage`                          |
| `message_stop`         | (terminal, no additional fields)                |

#### AssistantEvent

A completed assistant message.

| Field               | Type                    | Description                      |
|---------------------|-------------------------|----------------------------------|
| `type`              | `"assistant"`           | Event type                       |
| `message`           | AssistantMessagePayload | The complete assistant message   |
| `parent_tool_use_id`| string or null          | Tool use ID if nested            |
| `session_id`        | string                  | Engine session ID                |
| `uuid`              | string                  | Event UUID                       |

**AssistantMessagePayload:**

| Field        | Type           | Description                    |
|--------------|----------------|--------------------------------|
| `model`      | string         | Model that produced the message|
| `id`         | string         | Message ID                     |
| `role`       | `"assistant"`  | Always assistant               |
| `content`    | ContentBlock[] | Text and tool_use blocks       |
| `stop_reason`| string or null | Why the model stopped          |
| `usage`      | UsageData      | Token usage for this message   |

**ContentBlock:**

| Field   | Type   | Description                              |
|---------|--------|------------------------------------------|
| `type`  | string | `"text"` or `"tool_use"`                 |
| `text`  | string | Text content (for text blocks)           |
| `id`    | string | Tool use ID (for tool_use blocks)        |
| `name`  | string | Tool name (for tool_use blocks)          |
| `input` | object | Tool input (for tool_use blocks)         |

**UsageData:**

| Field                      | Type   | Description                    |
|----------------------------|--------|--------------------------------|
| `input_tokens`             | number | Input tokens consumed          |
| `output_tokens`            | number | Output tokens generated        |
| `cache_read_input_tokens`  | number | Tokens read from cache         |
| `cache_creation_input_tokens` | number | Tokens written to cache     |
| `service_tier`             | string | API service tier               |

#### ResultEvent

Signals completion of a run (success or error).

| Field                | Type                    | Description                      |
|----------------------|-------------------------|----------------------------------|
| `type`               | `"result"`              | Event type                       |
| `subtype`            | string                  | Result subtype                   |
| `is_error`           | boolean                 | `true` if the run failed         |
| `duration_ms`        | number                  | Total run duration in milliseconds |
| `num_turns`          | number                  | Number of LLM turns              |
| `result`             | string                  | Final result text or error message |
| `total_cost_usd`     | number                  | Total cost of the run in USD     |
| `session_id`         | string                  | Engine session ID                |
| `usage`              | UsageData               | Cumulative token usage           |
| `permission_denials` | PermissionDenialEntry[] | Tools that were denied           |
| `uuid`               | string                  | Event UUID                       |

**PermissionDenialEntry:**

| Field        | Type   | Description          |
|--------------|--------|----------------------|
| `tool_name`  | string | Name of denied tool  |
| `tool_use_id`| string | Tool use ID          |

#### RateLimitEvent

Signals a rate limit hit from the API provider.

| Field            | Type                 | Description               |
|------------------|----------------------|---------------------------|
| `type`           | `"rate_limit_event"` | Event type                |
| `rate_limit_info`| RateLimitInfo        | Rate limit details        |
| `session_id`     | string               | Engine session ID         |
| `uuid`           | string               | Event UUID                |

**RateLimitInfo:**

| Field           | Type   | Description                            |
|-----------------|--------|----------------------------------------|
| `status`        | string | Rate limit status                      |
| `resetsAt`      | number | Unix timestamp when limit resets       |
| `rateLimitType` | string | Type of rate limit                     |

#### PermissionEvent

Requests user approval for a tool invocation.

| Field         | Type             | Description                     |
|---------------|------------------|---------------------------------|
| `type`        | `"permission_request"` | Event type                |
| `tool`        | PermissionTool   | Tool requesting permission      |
| `question_id` | string          | Unique ID for this request      |
| `options`     | PermissionOpt[]  | Available response options      |
| `session_id`  | string           | Engine session ID               |
| `uuid`        | string           | Event UUID                      |

**PermissionTool:**

| Field         | Type   | Description           |
|---------------|--------|-----------------------|
| `name`        | string | Tool name             |
| `description` | string | Human-readable description |
| `input`       | object | Tool input parameters |

**PermissionOpt:**

| Field   | Type   | Description              |
|---------|--------|--------------------------|
| `id`    | string | Option ID (e.g., `"allow_once"`) |
| `label` | string | Display label            |
| `kind`  | string | Option kind              |

---

### Engine Events

Engine events are produced by the engine itself (not the LLM provider). They share a common `type` field prefixed with `engine_`.

#### engine_agent_state

Reports the current state of all agents in the session.

| Field    | Type               | Description               |
|----------|--------------------|---------------------------|
| `type`   | `"engine_agent_state"` | Event type            |
| `agents` | AgentStateUpdate[] | Current agent states      |

**AgentStateUpdate:**

| Field      | Type   | Description                    |
|------------|--------|--------------------------------|
| `name`     | string | Agent name                     |
| `status`   | string | Agent status                   |
| `metadata` | object | Additional metadata            |

#### engine_status

Reports session-level status changes.

| Field    | Type         | Description                        |
|----------|--------------|------------------------------------|
| `type`   | `"engine_status"` | Event type                   |
| `fields` | StatusFields | Session status fields              |

**StatusFields:**

| Field               | Type               | Description                   |
|---------------------|--------------------|-------------------------------|
| `label`             | string             | Display label                 |
| `state`             | string             | Session state                 |
| `sessionId`         | string             | Session ID                    |
| `team`              | string             | Team identifier               |
| `model`             | string             | Active model                  |
| `contextPercent`    | number             | Context window utilization %  |
| `contextWindow`     | number             | Context window size in tokens |
| `totalCostUsd`      | number             | Cumulative cost               |
| `permissionDenials` | PermissionDenial[] | Denied tool calls             |

#### engine_working_message

A status message indicating the engine is working on something.

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `type`    | `"engine_working_message"` | Event type          |
| `message` | string | Working status text                  |

#### engine_notify

A notification message from the engine.

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `type`    | `"engine_notify"` | Event type                  |
| `message` | string | Notification text                    |
| `level`   | string | Severity level                       |

#### engine_error

An error from the engine. Carries structured classification when the source error provides it (e.g., provider errors include HTTP status and retry timing). All fields except `type` and `message` are optional -- clients that only read `message` continue to work unchanged.

| Field           | Type    | Description                                    |
|-----------------|---------|------------------------------------------------|
| `type`          | `"engine_error"` | Event type                            |
| `message`       | string  | Human-readable error description               |
| `errorCode`     | string  | Machine-readable error code (see table below)  |
| `errorCategory` | string  | Error category for routing                     |
| `retryable`     | boolean | Whether the error is transient                 |
| `retryAfterMs`  | number  | Suggested retry delay in milliseconds          |
| `httpStatus`    | number  | HTTP status code from the provider             |

**Error Codes:**

| Code                | Category          | Retryable | Description                        |
|---------------------|-------------------|-----------|------------------------------------|
| `rate_limit`        | `provider_error`  | yes       | Provider rate limit (HTTP 429)     |
| `overloaded`        | `provider_error`  | yes       | Provider overloaded (HTTP 529/5xx) |
| `auth`              | `provider_error`  | no        | Authentication failure (401/403)   |
| `timeout`           | `provider_error`  | yes       | Request timeout                    |
| `network`           | `provider_error`  | yes       | Network connectivity failure       |
| `stale_connection`  | `provider_error`  | yes       | Connection reset                   |
| `invalid_model`     | `provider_error`  | no        | Model not found or unsupported     |
| `invalid_request`   | `provider_error`  | no        | Malformed request                  |
| `prompt_too_long`   | `provider_error`  | no        | Context exceeds model limit        |
| `content_filter`    | `provider_error`  | no        | Content policy violation           |
| `stream_truncated`  | `provider_error`  | yes       | Stream ended without stop reason   |
| `budget_exceeded`   | `provider_error`  | no        | Run cost exceeded budget limit     |
| `session_not_found` | `provider_error`  | no        | No session for the given key       |
| `queue_full`        | `provider_error`  | yes       | Prompt queue at capacity           |
| `hook_failed`       | `hook_error`      | no        | Extension hook threw an error. Message includes the stack trace. |

```json
{
  "type": "engine_error",
  "message": "rate_limit: 429 Too Many Requests",
  "errorCode": "rate_limit",
  "errorCategory": "provider_error",
  "retryable": true,
  "retryAfterMs": 60000,
  "httpStatus": 429
}
```

#### engine_harness_message

A message from the extension harness.

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `type`    | `"engine_harness_message"` | Event type          |
| `message` | string | Message text                         |
| `source`  | string | Extension or harness source name     |

#### engine_dialog

A dialog prompt from the engine requesting user input.

| Field          | Type     | Description                         |
|----------------|----------|-------------------------------------|
| `type`         | `"engine_dialog"` | Event type                  |
| `dialogId`     | string   | Dialog ID (use in `dialog_response`)|
| `method`       | string   | Dialog method                       |
| `title`        | string   | Dialog title                        |
| `options`      | string[] | Available options                   |
| `defaultValue` | string   | Default selection                   |

#### engine_text_delta

A chunk of streamed text from the engine (not the LLM stream, but engine-generated text).

| Field  | Type   | Description                              |
|--------|--------|------------------------------------------|
| `type` | `"engine_text_delta"` | Event type                  |
| `text` | string | Text chunk                               |

#### engine_message_end

Signals the end of a message with usage statistics.

| Field   | Type            | Description                        |
|---------|-----------------|------------------------------------|
| `type`  | `"engine_message_end"` | Event type                  |
| `usage` | MessageEndUsage | Token usage for the message        |

**MessageEndUsage:**

| Field            | Type   | Description                 |
|------------------|--------|-----------------------------|
| `inputTokens`    | number | Input tokens consumed       |
| `outputTokens`   | number | Output tokens generated     |
| `contextPercent` | number | Context utilization %       |
| `cost`           | number | Cost in USD for this message|

#### engine_tool_start

Signals the start of a tool execution.

| Field      | Type   | Description                         |
|------------|--------|-------------------------------------|
| `type`     | `"engine_tool_start"` | Event type               |
| `toolName` | string | Name of the tool being executed     |
| `toolId`   | string | Tool use ID                         |

#### engine_tool_end

Signals the completion of a tool execution.

| Field     | Type    | Description                          |
|-----------|---------|--------------------------------------|
| `type`    | `"engine_tool_end"` | Event type                  |
| `result`  | string  | Tool output                          |
| `isError` | boolean | `true` if the tool execution failed  |

#### engine_dead

Signals that the backend process exited unexpectedly.

| Field        | Type     | Description                         |
|--------------|----------|-------------------------------------|
| `type`       | `"engine_dead"` | Event type                    |
| `exitCode`   | number or null | Process exit code            |
| `signal`     | string or null | Signal that killed the process |
| `stderrTail` | string[] | Last lines of stderr output         |

#### engine_permission_request

A permission request from the engine (engine-level, separate from the LLM provider's PermissionEvent).

| Field                 | Type            | Description                        |
|-----------------------|-----------------|------------------------------------|
| `type`                | `"engine_permission_request"` | Event type          |
| `questionId`          | string          | Unique ID for this request         |
| `permToolName`        | string          | Tool name                          |
| `permToolDescription` | string          | Tool description                   |
| `permToolInput`       | object          | Tool input parameters              |
| `permOptions`         | PermissionOpt[] | Available response options         |

#### engine_plan_mode_changed

Signals a change in plan mode status.

| Field              | Type    | Description                       |
|--------------------|---------|-----------------------------------|
| `type`             | `"engine_plan_mode_changed"` | Event type       |
| `planModeEnabled`  | boolean | Whether plan mode is now active   |
| `planFilePath`     | string  | Path to the plan file             |
