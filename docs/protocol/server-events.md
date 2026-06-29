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

Complete snapshot of every agent the engine considers live at this instant. Consumers **must replace** their local agent view with this payload — do not merge, do not preserve entries not present here. An empty `agents: []` array means no agents are live and consumers must drop all entries. The engine guarantees a follow-up event with terminal status (or absence) for every agent that ends.

See [Agent State Contract](../architecture/agent-state.md) for the normative semantics, including extension-death recovery and reconnect handling.

| Field    | Type               | Description               |
|----------|--------------------|---------------------------|
| `type`   | `"engine_agent_state"` | Event type            |
| `agents` | AgentStateUpdate[] | Complete snapshot of live agents |

**AgentStateUpdate:**

| Field      | Type   | Description                    |
|------------|--------|--------------------------------|
| `name`     | string | Stable agent identifier (engine-assigned or harness-defined). |
| `status`   | string | One of `idle`, `running`, `done`, `error`, `cancelled`. `running` is the only non-terminal value. |
| `metadata` | object | Open-ended map of well-known and harness-defined keys (see below). |

**Well-known metadata keys** (advisory — clients render what they understand, ignore the rest):

| Key | Type | Purpose |
|---|---|---|
| `displayName` | string | Human-friendly name for UI. |
| `type` | string | `chief`, `specialist`, `staff`, `consultant`, or `agent` (engine default). |
| `visibility` | string | `always`, `sticky`, or `ephemeral`. |
| `invited` | bool | True after the agent has been dispatched at least once. |
| `color` | string | CSS color for the agent's badge. |
| `model` | string | Provider model id. |
| `task` | string | The prompt handed to this agent. |
| `lastWork` | string | Short summary (≤100 chars). |
| `fullOutput` | string | Full agent output. |
| `elapsed` | number | Wall-clock seconds since `startTime`. |
| `startTime` | number | Unix timestamp (seconds) when this run began. |
| `cost` | number | Cumulative USD cost for this session. |
| `conversationId` | string | Backend session id for rewind features. |
| `parentAgent` | string | Dispatching agent name (for tree views). |
| `depth` | number | Nesting depth from the root run. |

Extensions may add their own metadata keys; pick a unique prefix.

#### engine_status

Reports session-level status changes.

| Field    | Type         | Description                        |
|----------|--------------|------------------------------------|
| `type`   | `"engine_status"` | Event type                   |
| `fields` | StatusFields | Session status fields              |
| `metadata` | object | Opaque harness-defined metadata (see [Well-known metadata keys for engine_harness_message](#well-known-metadata-keys-for-engine_harness_message) below). Engine forwards verbatim; clients may honor specific keys. |

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
| `metadata` | object | Opaque harness-defined metadata (see [Well-known metadata keys for engine_harness_message](#well-known-metadata-keys-for-engine_harness_message) below). Engine forwards verbatim; clients may honor specific keys. |

#### engine_notify

A notification message from the engine.

| Field     | Type   | Description                          |
|-----------|--------|--------------------------------------|
| `type`    | `"engine_notify"` | Event type                  |
| `message` | string | Notification text                    |
| `level`   | string | Severity level                       |
| `metadata` | object | Opaque harness-defined metadata (see [Well-known metadata keys for engine_harness_message](#well-known-metadata-keys-for-engine_harness_message) below). Engine forwards verbatim; clients may honor specific keys. |

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
| `metadata` | object | Opaque harness-defined metadata (see well-known keys below). Engine forwards verbatim; clients may honor specific keys. |

##### Well-known metadata keys for engine_harness_message

`metadata` on `engine_harness_message` (and on `engine_notify`, `engine_working_message`, `engine_status`) is an open-ended map of harness-defined hints. The engine treats the field as opaque pass-through — it neither validates nor interprets it. Conventions below are advisory: clients render what they understand and ignore the rest. Extensions may introduce their own keys; pick a unique prefix.

| Key | Type | Purpose |
|---|---|---|
| `dedupKey` | string | Renderer-side dedup tag. The desktop session store suppresses repeated harness messages with the same `dedupKey` within a single engine-instance scrollback, so a re-emitted welcome on every `session_start` (e.g. across app restart with no intervening user turn) renders at most once per tab. Namespace convention: `<extensionName>:<messageKey>` (e.g. `ion-meta:welcome`). iOS receives the key on the wire but does not currently honor it; future iOS-side dedup is forward-compatible without a protocol change. The key persists with the message so the renderer's dedup table survives restart and rehydrate. |

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

#### engine_dispatch_activity

Streams a running dispatched (sub-)agent's intra-turn activity to the parent
session's event stream: a tool call starting, a tool result returning, or a
chunk of streamed assistant text. The child agent produces these as it works,
so a consumer can render or audit the live sub-agent transcript **without
waiting for the dispatch to complete** — the key difference from the
`engine_dispatch_start` / `engine_dispatch_end` telemetry pair, which fire only
at the boundaries.

**Semantics: incremental, append-by-key.** Not a snapshot, not retained, not
replayed on reconnect (contrast `engine_agent_state`, which *is* a snapshot).
The file-backed conversation transcript is the authoritative source that heals
any gap: a consumer that needs the complete or sticky transcript reconciles
from conversation history (e.g. by loading the child `conversationId`), not from
retained activity events. This mirrors the fire-once, non-retained contract of
`engine_model_fallback` and `engine_run_stalled`.

Identity for client-side dedup against a reconcile snapshot: route the delta by
`dispatchAgentId` (never into the parent conversation's own message stream),
dedup tool entries by `toolId` (durable and also persisted, so it survives
reconcile), and key a streaming-text run by `dispatchSeq`.

| Field                    | Type    | Description |
|--------------------------|---------|-------------|
| `type`                   | `"engine_dispatch_activity"` | Event type |
| `dispatchAgentId`        | string  | Parent-side agent id; routes the delta to the right agent/dispatch row. |
| `dispatchConversationId` | string  | The child conversation id (reconcile key). |
| `dispatchActivityKind`   | string  | `"tool_start"` \| `"tool_end"` \| `"text"`. |
| `dispatchSeq`            | number  | Monotonic per-dispatch sequence; orders deltas and keys a text run. |
| `toolName`               | string  | Tool name (`tool_start`). |
| `toolId`                 | string  | Tool use id (`tool_start` / `tool_end`). |
| `dispatchTextDelta`      | string  | Streamed text chunk, possibly coalesced (`text`). |
| `dispatchToolIsError`    | boolean | `true` when the tool failed (`tool_end`). |
| `dispatchActivityTs`     | number  | Emit timestamp (unix millis). |

#### engine_dead

Signals that the backend process terminated **abnormally** — a non-zero exit
code, or any terminating signal other than the cooperative `cancelled`.

**A clean cancel does NOT fire `engine_dead`.** When a run is interrupted on
purpose (`exitCode` is `0` or null **and** `signal` is `"cancelled"` — a user
or auto abort, or a turn/tool hook cancelling the run), the run is a clean,
recoverable exit: the conversation is intact and the session is immediately
reusable. That path is surfaced via the idle `engine_status` only; no
`engine_dead` is emitted. `engine_dead` is reserved for real deaths a consumer
must surface (`SIGKILL`, `SIGSEGV`, the watchdog's `cancelled-forced` hard
kill, or any non-zero exit). See
[ADR-013](../architecture/adr/013-engine-dead-clean-cancel.md) for the semantic
rationale and migration impact.

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

#### engine_elicitation_request

Emitted when an extension calls `ctx.elicit()` (TypeScript SDK) or `ctx.Elicit()` (Go SDK). The engine blocks the extension's call and waits for a matching `elicitation_response` client command. Clients present the schema-driven prompt to the user and reply via `elicitation_response`. The engine forwards the reply to the waiting extension so its `ctx.elicit()` Promise resolves.

The engine never cancels a pending elicitation on its own. If the client disconnects without replying, the waiting extension call eventually times out per the session's configured elicitation timeout. See [`ctx.elicit()`](../extensions/sdk-typescript.md) for the extension-side API.

| Field        | Type   | Description |
|--------------|--------|-------------|
| `type`       | `"engine_elicitation_request"` | Event type |
| `requestId`  | string | Opaque correlator. Echo this in the matching `elicitation_response` command so the engine can pair the reply. |
| `schema`     | object | JSON Schema describing the response shape the extension expects. |
| `url`        | string | Optional URL the client may open to present a richer elicitation UI. |
| `elicitMode` | string | Rendering hint from the extension (e.g. `"input"`, `"confirm"`). |

#### engine_elicitation_response

Emitted by the engine after it receives and processes an `elicitation_response` client command. Lets other connected clients (e.g. a desktop observer alongside iOS) see that the elicitation was resolved.

| Field        | Type   | Description |
|--------------|--------|-------------|
| `type`       | `"engine_elicitation_response"` | Event type |
| `requestId`  | string | Correlator matching the original `engine_elicitation_request`. |
| `response`   | object | The user's response payload, conforming to the `schema` from the request. Absent when cancelled. |
| `cancelled`  | boolean | `true` when the user dismissed the prompt without submitting a response. |

#### engine_plan_mode_changed

Signals a confirmed change in plan mode status. **State transitions only** —
the model calling `ExitPlanMode` does **not** fire this event, because the
mode change is deferred to the user-approval chokepoint. See
[ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md) for
the state-vs-workflow split and [`engine_plan_proposal`](#engine_plan_proposal)
for the workflow signal that fires when the model proposes an exit.

Triggers:

- The harness calls `SetPlanMode(true)` or `SetPlanMode(false)`.
- A run starts with `PlanMode: true` in `RunOptions`.
- Plan mode is aborted (engine-internal failure path).
- The user-approval chokepoint approves the exit and calls `SetPlanMode(false)`.

| Field              | Type    | Description                       |
|--------------------|---------|-----------------------------------|
| `type`             | `"engine_plan_mode_changed"` | Event type       |
| `planModeEnabled`  | boolean | Whether plan mode is now active   |
| `planFilePath`     | string  | Path to the plan file (omitempty) |
| `planSlug`         | string  | Human-readable basename of the plan file with `.md` stripped (omitempty) |

#### engine_plan_proposal

Workflow event emitted when the model proposes a plan-mode transition. The
proposal is a *request* — the actual state change is deferred to the
consumer's user-approval chokepoint. Distinct from
[`engine_plan_mode_changed`](#engine_plan_mode_changed), which fires only on
confirmed state transitions. See
[ADR-003](../architecture/adr/003-state-events-vs-workflow-events.md) for
the rationale.

The `planProposalKind` field discriminates the proposal type. Consumers must
switch on the kind and treat unknown kinds as forward-compatible no-ops.

| Kind     | Trigger                              |
|----------|--------------------------------------|
| `"exit"` | The model called the `ExitPlanMode` tool. The consumer should present an approval UI (e.g. a card with "Implement" and "Keep planning" actions). If the user approves, the consumer calls `SetPlanMode(false)`, which fires the corresponding `engine_plan_mode_changed{Enabled: false}` event. If the user dismisses, no state change occurs. |

Future kinds may include `"enter"` (proposed entry) and `"amend"` (proposed
amendment to an in-progress plan).

| Field              | Type    | Description                       |
|--------------------|---------|-----------------------------------|
| `type`             | `"engine_plan_proposal"` | Event type       |
| `planProposalKind` | string  | Discriminator: `"exit"` initially. Unknown kinds must be ignored. |
| `planFilePath`     | string  | Path to the plan file (omitempty) |
| `planSlug`         | string  | Human-readable basename of the plan file with `.md` stripped (omitempty) |

**Relationship to the permission denial.** When the model calls
`ExitPlanMode`, the engine also records a permission denial that flows
through `engine_status.permissionDenials` and (at run end)
`task_complete.permissionDenials`. The denial is a *tool-permission record*
and was the only signal available before this event existed. Consumers that
still derive approval-card rendering from `permissionDenied.tools[]` keep
working unchanged; new consumers should prefer the typed
`engine_plan_proposal` event because it arrives as soon as the model calls
the tool (not at run end) and carries `planFilePath` / `planSlug` directly
without scraping `toolInput`.

#### engine_command_registry

Complete snapshot of the slash commands currently registered by the
session's loaded extensions. Emitted at session start (after extensions
wire up) and on every subsequent change to the command map (mid-session
`RegisterCommand` calls inside a hook handler, extension hot reload,
etc.). Consumers REPLACE their cached set with this payload — never
merge. An empty `commands: []` array is the authoritative "no extension
commands live for this session" signal.

Snapshot semantics follow the same rules as `engine_agent_state`; see
[Agent State Contract](../architecture/agent-state.md) for the canonical
example. Consumers using the snapshot as a routing-hint cache (e.g. the
desktop's prompt pipeline, which short-circuits local `.md` template
lookups when an extension owns the same slash name) must drop entries
absent from the latest snapshot, not retain them defensively.

The engine never trusts a consumer's cache when dispatching a command —
`Manager.SendCommand` resolves the live command table at dispatch time —
so a freshly-registered command will be found even when the snapshot
event is still in flight. The cache is purely a hint.

| Field          | Type                          | Description                            |
|----------------|-------------------------------|----------------------------------------|
| `type`         | `"engine_command_registry"`   | Event type                             |
| `commands`     | `EngineCommandListing[]`      | Complete current command set (sorted alphabetically for deterministic output). Empty array is the authoritative "no extension commands" signal. |

`EngineCommandListing` is a `{ name, description? }` pair. `name` is the
bare slash name (e.g. `"clear"`, `"ion--review-changes"`).
`description` is an optional human-readable hint the autocomplete UI
surfaces.

#### engine_command_result

Result of every `Manager.SendCommand` dispatch: success (no error),
extension-command failure (extension threw), or unknown command (engine
disclaims the name). Emitted exactly once per dispatch, after the
command's execution path completes.

Consumers awaiting a slash dispatch (typically the desktop's prompt
pipeline) read this event to decide between "engine handled it, draw
the divider and move on" and "engine disclaimed the name, fall through
to local `.md` template expansion."

| Field          | Type                       | Description                                                                                                                          |
|----------------|----------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| `type`         | `"engine_command_result"`  | Event type                                                                                                                           |
| `command`      | string (omitempty)         | Bare command name the engine resolved (e.g. `"clear"`, `"ion--review-changes"`). May be empty for the catch-all error emit.          |
| `message`      | string (omitempty)         | Human-readable note. Often empty on success.                                                                                         |
| `commandError` | string (omitempty)         | Set when the dispatch failed. Special value `"unknown_command"` is reserved for the engine disclaiming the name (treat as "the engine does not own this command, route it locally"). Any other value is an extension-thrown error message. |

#### engine_export

Carries the rendered output of a built-in `/export [format]` command. The
engine's `dispatchExport` loads the conversation, renders it in the
requested format, and emits this event **before** the matching
`engine_command_result`, so a consumer awaiting the dispatch receives the
payload before the completion signal.

`exportFormat` is the format the engine resolved from the `/export` args:
one of `"markdown"`, `"json"`, `"html"`, or `"jsonl"`. When the user runs
`/export` with no args, the engine defaults to `"markdown"`. Consumers use
`exportFormat` to choose a file extension / MIME type directly — they do
**not** need to sniff the payload bytes.

The engine attaches no rendering or persistence semantics. Reference
consumers interpret the payload per their own UX: the desktop opens a
save-as dialog, iOS presents a share sheet writing a typed temp file, and
a headless consumer (CLI orchestrator, custom harness) may pipe the
payload to stdout, write it to a predetermined path, or stream it over its
own transport.

| Field          | Type                | Description                                                                                                  |
|----------------|---------------------|--------------------------------------------------------------------------------------------------------------|
| `type`         | `"engine_export"`   | Event type                                                                                                   |
| `message`      | string              | The full rendered export payload (markdown / json / html / jsonl).                                           |
| `exportFormat` | string (omitempty)  | Resolved format: `"markdown"` (default), `"json"`, `"html"`, or `"jsonl"`. Use to pick a file extension / MIME type. |

#### engine_early_stop_decision_request

Wire-protocol surface for the `before_early_stop_decision` extension
hook. Emitted when the model has just emitted `end_turn` / `stop` below
the configured output-token target *and* no subprocess extension has
already expressed an opinion via the in-process hook. Lets socket-only
harnesses (e.g. the desktop's `early-stop-policy.ts`) participate in
the decision without running a subprocess extension. See
[ADR-002](../architecture/adr/002-engine-vs-harness-early-stop.md) for
the engine-vs-harness boundary that motivates the request/response
shape.

The engine blocks briefly (100ms timeout) on a matching
`early_stop_decision_response` client command. A missed deadline is
treated as "no opinion" — the engine falls through to its existing
merge logic. Without a `ContinueMessage` supplied by any source
(subprocess hook, wire response, or `RunOptions`), the engine logs the
no-message-skip and falls through to normal `TaskCompleteEvent`
emission. The feature is off by default; see ADR-002 for the
three-layer disable matrix.

| Field                              | Type                                  | Description                                                                                                |
|------------------------------------|---------------------------------------|------------------------------------------------------------------------------------------------------------|
| `type`                             | `"engine_early_stop_decision_request"` | Event type                                                                                                 |
| `earlyStopRequestId`               | string                                | Opaque correlator. The consumer must echo this in its `early_stop_decision_response` so the engine can pair the reply to this request. |
| `earlyStopRunId`                   | string                                | Engine-internal run identifier.                                                                            |
| `earlyStopModel`                   | string                                | Model id that just stopped.                                                                                |
| `earlyStopTurnNumber`              | int                                   | Turn number within the run.                                                                                |
| `earlyStopStopReason`              | string                                | The model's stop reason (typically `"end_turn"` or `"stop"`).                                              |
| `earlyStopCumulativeOutput`        | int                                   | Cumulative output tokens emitted so far this run.                                                          |
| `earlyStopBudget`                  | int                                   | Resolved budget for this run (after merge through defaults / `engine.json` / `RunOptions`).                |
| `earlyStopThresholdPct`            | int                                   | Resolved completion threshold percent.                                                                     |
| `earlyStopContinuationCount`       | int                                   | Number of continuation nudges already injected this run.                                                   |
| `earlyStopMaxContinuations`        | int                                   | Resolved cap on continuation nudges.                                                                       |
| `earlyStopLastContinuationDelta`   | int                                   | Output-token delta from the previous continuation. Used by the diminishing-returns guard.                  |
| `earlyStopWouldContinue`           | bool                                  | Engine's tentative verdict before harness input. Harness response can override either way.                 |
| `earlyStopIsSubagent`              | bool                                  | `true` when the run is a child-agent dispatch. The engine's default is off for sub-agents; harness can still force on. |

The matching response client command shape:

| Field                              | Type             | Description                                                                                                                                                      |
|------------------------------------|------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `cmd`                              | `"early_stop_decision_response"` | Command type                                                                                                                                      |
| `key`                              | string           | Session key (same key carried on the request).                                                                                                                   |
| `earlyStopRequestId`               | string           | Echo of the request id.                                                                                                                                          |
| `earlyStopForceContinue`           | `*bool` (omit)   | Override the engine's tentative verdict. `null` / omitted = no opinion; `false` = explicit do-not-continue; `true` = explicit continue.                          |
| `earlyStopOverrideBudget`          | int (omitempty)  | Optional budget override applied to this and subsequent continuation decisions in the same run.                                                                  |
| `earlyStopOverrideThresholdPct`    | int (omitempty)  | Optional threshold-percent override.                                                                                                                             |
| `earlyStopContinueMessage`         | string (omitempty) | Harness-supplied continuation prose. The engine injects this verbatim as the next user message when the resolved verdict is "continue." Empty = engine skips the continuation (no nudge fires). |

An empty response (only `key` + `earlyStopRequestId`, no other fields)
is a valid "no opinion" reply. The engine treats it the same as a
missed-deadline fallback.

#### Async-trigger events

Observation-only advisory events emitted by the webhook server, scheduler, and async-registration lifecycle. Consumers render audit logs and "what's registered" panels from these events. They are **incremental** (not snapshots) and **advisory** — consumers must not build state machines on them.

**Shared fields** (all `omitempty`; each event type carries the subset relevant to it):

| Field           | Type              | Description                                                                 |
|-----------------|-------------------|-----------------------------------------------------------------------------|
| `asyncKind`     | string            | `"webhook"` or `"schedule"` — discriminates the trigger kind.               |
| `asyncId`       | string            | Declaration's stable id (webhook path or schedule job id).                  |
| `asyncOrigin`   | string            | `"init"` or `"runtime"` — lifecycle events only.                            |
| `asyncReason`   | string            | Cause for negative-path events (see per-type notes below).                  |
| `asyncDecl`     | json.RawMessage   | Declaration JSON — lifecycle events only. Auth secrets are never included.  |
| `asyncRequestId`| string            | Correlates a single webhook request across received → responded.            |
| `asyncMethod`   | string            | HTTP method — webhook fire events only.                                     |
| `asyncPath`     | string            | HTTP path — webhook fire events only.                                       |
| `asyncStatus`   | int               | HTTP response status — `engine_webhook_responded` and `engine_webhook_handler_error`. |
| `asyncDurationMs`| int64            | Elapsed time from receipt to response (webhook) or fire to handler-return (schedule). |

**Event types:**

| Type                              | Category            | Key fields                                                    | Notes |
|-----------------------------------|----------------------|---------------------------------------------------------------|-------|
| `engine_webhook_registered`       | Webhook lifecycle    | `asyncKind`, `asyncId`, `asyncOrigin`, `asyncDecl`            | Route accepted by the registry. |
| `engine_webhook_deregistered`     | Webhook lifecycle    | `asyncKind`, `asyncId`, `asyncOrigin`, `asyncDecl`            | Route removed (runtime or teardown). |
| `engine_webhook_received`         | Webhook fire         | `asyncKind`, `asyncId`, `asyncRequestId`, `asyncMethod`, `asyncPath` | Inbound request matched a route. |
| `engine_webhook_authenticated`    | Webhook fire         | `asyncKind`, `asyncId`, `asyncRequestId`, `asyncMethod`, `asyncPath` | Auth passed. |
| `engine_webhook_responded`        | Webhook fire         | `asyncKind`, `asyncId`, `asyncRequestId`, `asyncMethod`, `asyncPath`, `asyncStatus`, `asyncDurationMs` | Handler completed; response written. |
| `engine_webhook_handler_error`    | Webhook fire (error) | `asyncKind`, `asyncId`, `asyncRequestId`, `asyncMethod`, `asyncPath`, `asyncStatus`, `asyncReason`, `asyncDurationMs` | `asyncReason`: `"auth"`, `"body_size"`, `"handler_failed"`, `"method_not_allowed"`, `"not_found"`, `"timeout"`. |
| `engine_schedule_registered`      | Schedule lifecycle   | `asyncKind`, `asyncId`, `asyncOrigin`, `asyncDecl`            | Job accepted by the registry. |
| `engine_schedule_deregistered`    | Schedule lifecycle   | `asyncKind`, `asyncId`, `asyncOrigin`, `asyncDecl`            | Job removed (runtime or teardown). |
| `engine_schedule_fired`           | Schedule fire        | `asyncKind`, `asyncId`, `asyncDurationMs`                     | Handler completed successfully. |
| `engine_schedule_skipped`         | Schedule fire (skip) | `asyncKind`, `asyncId`, `asyncReason`                         | `asyncReason`: `"disabled"`, `"no_resolver"`, `"no_session"`, `"predicate_error"`. |
| `engine_schedule_failed`          | Schedule fire (error)| `asyncKind`, `asyncId`, `asyncReason`, `asyncDurationMs`      | Handler threw; `asyncReason` carries the error message. |
| `engine_async_fire_dropped`       | Shared error         | `asyncKind`, `asyncId`, `asyncReason`                         | Fire could not proceed. `asyncReason`: `"no_session"`, `"cap_exceeded"`, `"subprocess_dead"`, `"unregistered"`, `"no_resolver"`. |

#### engine_resource_snapshot

Snapshot-replace semantics. Sent when a client first subscribes to a resource kind and whenever a full refresh is needed. Consumers must replace their local collection for this kind with the snapshot contents.

| Field           | Type              | Description                                         |
|-----------------|-------------------|-----------------------------------------------------|
| `type`          | `"engine_resource_snapshot"` | Event type                             |
| `resourceKind`  | string            | The subscribed resource kind                        |
| `resourceSubId` | string            | Subscription ID (from `resource_subscribe` response)|
| `resourceItems` | ResourceItem[]    | Complete current collection for this kind           |

#### engine_resource_delta

Incremental resource update. Sent after the initial snapshot whenever an item is created, updated, deleted, or marked read.

| Field           | Type              | Description                                         |
|-----------------|-------------------|-----------------------------------------------------|
| `type`          | `"engine_resource_delta"` | Event type                               |
| `resourceKind`  | string            | The subscribed resource kind                        |
| `resourceSubId` | string            | Subscription ID                                     |
| `resourceDelta` | object            | Delta descriptor (see below)                        |

**ResourceDelta:**

| Field  | Type         | Description                                              |
|--------|--------------|----------------------------------------------------------|
| `op`   | string       | One of `"create"`, `"update"`, `"delete"`, `"mark_read"` |
| `item` | ResourceItem | The affected item                                        |

#### engine_notification

Push notification signal from an extension. The `push`/`pushTitle`/`pushBody` fields trigger APNs delivery through the relay when the iOS client is connected. The `notify*` fields carry the in-app notification payload for desktop and web clients.

| Field              | Type    | Description                                                                 |
|--------------------|---------|-----------------------------------------------------------------------------|
| `type`             | `"engine_notification"` | Event type                                                    |
| `push`             | boolean | When `true`, triggers an APNs push through the relay                        |
| `pushTitle`        | string  | APNs alert title                                                            |
| `pushBody`         | string  | APNs alert body                                                             |
| `notifyKind`       | string  | Application-defined notification kind                                       |
| `notifyResourceId` | string  | Optional resource ID the notification relates to                            |
| `notifyTitle`      | string  | In-app notification title                                                   |
| `notifyBody`       | string  | In-app notification body                                                    |
| `notifySound`      | boolean | Whether to play a sound on delivery                                         |
| `notifyScope`      | string  | Optional scope hint (e.g. `"session"`, `"global"`)                          |

#### engine_session_status

Typed per-session status snapshot. Emitted alongside the legacy `engine_status` during the transition window and re-emitted by the heartbeat every 30 seconds. Semantics: snapshot-replace per session key. Consumers replace their cached status for the given key with this payload.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"engine_session_status"` | Event type |
| `sessionStatus` | SessionStatus | Complete status payload (see below) |

**SessionStatus fields:**

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Session key (tabId or tabId:instanceId) |
| `state` | string | Authoritative state: `"idle"`, `"running"` |
| `stateSince` | number | Unix-ms timestamp when the session entered the current state |
| `lastEmittedAt` | number | Unix-ms timestamp of this emission |
| `hasInflightRun` | boolean | True when the backend has a live run |
| `backgroundAgentCount` | number | Number of background dispatch agents still running |
| `permissionDenialsPending` | array | Unresolved AskUserQuestion / ExitPlanMode entries |
| `model` | string | Model the most recent run resolved to |
| `contextPercent` | number | Context-window usage percent |
| `contextWindow` | number | Model's context window in tokens |
| `totalCostUsd` | number | Cumulative conversation cost in USD |
| `sessionId` | string | Conversation ID |
| `extensionName` | string | Name of the loaded extension |

#### engine_run_stalled

Advisory workflow signal emitted once per run when the engine's progress watchdog detects no forward progress for longer than the configured threshold and cancels the run. Not retained or replayed on reconnect. The authoritative completion signal is the follow-up `engine_task_complete`.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"engine_run_stalled"` | Event type |
| `runStalledDuration` | number | Seconds since last progress event |
| `runStalledLastActivity` | string | Description of the most recent progress event (optional) |

#### engine_intercept

Fire-and-forget signal emitted when an extension calls `ctx.Intercept()`. The engine attaches no semantics beyond routing. Not retained or replayed on reconnect.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"engine_intercept"` | Event type |
| `interceptLevel` | string | `"banner"` (informational) or `"redirect"` (urgent) |
| `interceptTitle` | string | Short headline |
| `interceptMessage` | string | Body content |
| `interceptSource` | string | Extension name (set by engine, not caller) |
| `interceptMetadata` | object | Opaque map forwarded to clients unchanged |

---

## Slash-Command Provenance on Message Events

When a user turn originates from a slash-command invocation, the engine persists the **raw** invocation (the `/name args` the user typed) as the displayed turn, while the model sees the expanded template body. Three provenance fields travel with that message wherever it appears on the wire.

### `load_session_history` — SessionMessage

The `load_session_history` response includes these fields on user-role `SessionMessage` objects:

| Field          | Type   | Description |
|----------------|--------|-------------|
| `slashCommand` | string | The full command as the user typed it, including the leading slash (e.g. `/spec`). Present only on turns that originated from a slash invocation. |
| `slashArgs`    | string | The argument text that followed the command name. May be empty. |
| `slashSource`  | string | Where the command was resolved: `"ion"` (`.ion/commands`), `"claude"` (`.claude/commands`), `"skill"`, or `"extension"` (registered via `RegisterCommand`). |

### `desktop_message_added` / `desktop_conversation_history` — RemoteMessage

The same three fields appear on `RemoteMessage` objects sent to paired iOS clients via `desktop_message_added` and `desktop_conversation_history` remote events. When `slashCommand` is non-empty, the iOS client renders a pill showing the command name; `slashArgs` and `slashSource` supply the pill's detail text and badge.

| Field          | Type   | Description |
|----------------|--------|-------------|
| `slashCommand` | string | Full slash invocation (e.g. `/spec`). |
| `slashArgs`    | string | Arguments following the command name. |
| `slashSource`  | string | Resolution origin: `"ion"`, `"claude"`, `"skill"`, or `"extension"`. |

The engine sets these fields via the session layer's slash-stash mechanism (see `pendingSlashInvocation` in `engine/internal/session/types.go`). For extension-dispatched prompts, the stash is written by `dispatchCommand` and consumed by `SendPrompt`; for direct `send_prompt` invocations the engine resolves the command inline when `resolveSlash` is `true` on the command.
