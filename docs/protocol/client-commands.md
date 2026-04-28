---
title: Client Commands
description: All 20 client commands in the Ion Engine socket protocol.
sidebar_position: 2
---

# Client Commands

Commands are JSON objects sent from a client to the engine over the socket. Every command must include a `cmd` field. Most commands require a `key` field identifying the target session.

Include a `requestId` string to receive a `ServerResult` response. If omitted, the engine processes the command silently (no acknowledgment).

## Command Reference

### start_session

Start a new engine session.

| Field    | Type           | Required | Description                        |
|----------|----------------|----------|------------------------------------|
| `cmd`    | `"start_session"` | yes   | Command discriminator              |
| `key`    | string         | yes      | Client-chosen session identifier   |
| `config` | EngineConfig   | yes      | Session configuration object       |
| `requestId` | string      | no       | Correlates with ServerResult       |

**EngineConfig fields:**

| Field              | Type     | Required | Description                          |
|--------------------|----------|----------|--------------------------------------|
| `profileId`        | string   | yes      | Extension profile ID                 |
| `extensions`       | string[] | yes      | Paths to extension directories       |
| `workingDirectory` | string   | yes      | Working directory for the session    |
| `sessionId`        | string   | no       | Resume an existing session           |
| `maxTokens`        | number   | no       | Max output tokens per response       |
| `thinking`         | object   | no       | Extended thinking config (`enabled`, `budgetTokens`) |
| `systemHint`       | string   | no       | Additional system prompt content     |

```json
{"cmd":"start_session","key":"abc-123","config":{"profileId":"default","extensions":["~/.ion/extensions/my-ext"],"workingDirectory":"/home/user/project"},"requestId":"r1"}
```

**Response:** `ServerResult` with `ok: true` on success.

---

### send_prompt

Send a user message to an active session.

| Field          | Type     | Required | Description                          |
|----------------|----------|----------|--------------------------------------|
| `cmd`          | `"send_prompt"` | yes | Command discriminator               |
| `key`          | string   | yes      | Session key                          |
| `text`         | string   | yes      | The user's prompt text               |
| `model`        | string   | no       | Model override for this prompt       |
| `maxTurns`     | number   | no       | Max LLM turns for this run           |
| `maxBudgetUsd` | number   | no       | Spending cap in USD                  |
| `extensionDir` | string   | no       | Override extension directory         |
| `noExtensions` | boolean  | no       | Disable extensions for this run      |
| `requestId`    | string   | no       | Correlates with ServerResult         |

```json
{"cmd":"send_prompt","key":"abc-123","text":"List all files in the current directory","requestId":"r2"}
```

**Response:** `ServerResult` with `ok: true`. Session events stream as broadcast `ServerEvent` messages.

---

### abort

Abort the current run in a session. Fire-and-forget; no result is sent.

| Field  | Type       | Required | Description              |
|--------|------------|----------|--------------------------|
| `cmd`  | `"abort"`  | yes      | Command discriminator    |
| `key`  | string     | yes      | Session key              |

```json
{"cmd":"abort","key":"abc-123"}
```

---

### abort_agent

Abort a specific named agent within a session. Fire-and-forget.

| Field       | Type             | Required | Description                        |
|-------------|------------------|----------|------------------------------------|
| `cmd`       | `"abort_agent"`  | yes      | Command discriminator              |
| `key`       | string           | yes      | Session key                        |
| `agentName` | string           | yes      | Name of the agent to abort         |
| `subtree`   | boolean          | no       | Also abort child agents            |

```json
{"cmd":"abort_agent","key":"abc-123","agentName":"researcher","subtree":true}
```

---

### steer_agent

Inject a steering message into a running agent. Fire-and-forget.

| Field       | Type              | Required | Description                       |
|-------------|-------------------|----------|-----------------------------------|
| `cmd`       | `"steer_agent"`   | yes      | Command discriminator             |
| `key`       | string            | yes      | Session key                       |
| `agentName` | string            | yes      | Name of the agent to steer        |
| `message`   | string            | yes      | Steering message text             |

```json
{"cmd":"steer_agent","key":"abc-123","agentName":"researcher","message":"Focus on the API layer only"}
```

---

### stop_session

Stop and clean up a session.

| Field      | Type              | Required | Description              |
|------------|-------------------|----------|--------------------------|
| `cmd`      | `"stop_session"`  | yes      | Command discriminator    |
| `key`      | string            | yes      | Session key              |
| `requestId`| string            | no       | Correlates with ServerResult |

```json
{"cmd":"stop_session","key":"abc-123","requestId":"r3"}
```

**Response:** `ServerResult` with `ok: true` on success.

---

### stop_by_prefix

Stop all sessions whose key starts with the given prefix.

| Field      | Type               | Required | Description              |
|------------|--------------------|----------|--------------------------|
| `cmd`      | `"stop_by_prefix"` | yes      | Command discriminator    |
| `prefix`   | string             | yes      | Key prefix to match      |
| `requestId`| string             | no       | Correlates with ServerResult |

```json
{"cmd":"stop_by_prefix","prefix":"batch-","requestId":"r4"}
```

**Response:** `ServerResult` with `ok: true`.

---

### list_sessions

List all active sessions.

| Field      | Type               | Required | Description              |
|------------|--------------------|----------|--------------------------|
| `cmd`      | `"list_sessions"`  | yes      | Command discriminator    |
| `requestId`| string             | no       | Correlates with ServerResult |

```json
{"cmd":"list_sessions","requestId":"r5"}
```

**Response with requestId:** `ServerResult` with `data` containing an array of `SessionInfo` objects.

**Response without requestId:** `ServerSessionList` message:

```json
{"cmd":"session_list","sessions":[{"key":"abc-123","hasActiveRun":true,"toolCount":14}]}
```

**SessionInfo fields:**

| Field          | Type    | Description                       |
|----------------|---------|-----------------------------------|
| `key`          | string  | Session identifier                |
| `hasActiveRun` | boolean | Whether a prompt is being processed |
| `toolCount`    | number  | Number of registered tools        |

---

### fork_session

Fork a session at a specific message index, creating a new session with conversation history up to that point.

| Field          | Type              | Required | Description                        |
|----------------|-------------------|----------|------------------------------------|
| `cmd`          | `"fork_session"`  | yes      | Command discriminator              |
| `key`          | string            | yes      | Source session key                  |
| `messageIndex` | number            | yes      | Message index to fork at           |
| `requestId`    | string            | no       | Correlates with ServerResult       |

```json
{"cmd":"fork_session","key":"abc-123","messageIndex":4,"requestId":"r6"}
```

**Response:** `ServerResult` with `ok: true` and `newKey` field containing the forked session's key.

```json
{"cmd":"result","requestId":"r6","ok":true,"newKey":"abc-123-fork-1"}
```

---

### set_plan_mode

Toggle plan mode for a session. In plan mode, the agent plans without executing tools (or executes only allowed tools).

| Field          | Type               | Required | Description                          |
|----------------|--------------------|----------|--------------------------------------|
| `cmd`          | `"set_plan_mode"`  | yes      | Command discriminator                |
| `key`          | string             | yes      | Session key                          |
| `enabled`      | boolean            | yes      | Enable or disable plan mode          |
| `allowedTools` | string[]           | no       | Tools allowed during plan mode       |
| `requestId`    | string             | no       | Correlates with ServerResult         |

```json
{"cmd":"set_plan_mode","key":"abc-123","enabled":true,"allowedTools":["Read","Glob"],"requestId":"r7"}
```

**Response:** `ServerResult` with `ok: true`.

---

### branch

Create a new branch in the conversation tree at the given entry.

| Field      | Type         | Required | Description                          |
|------------|--------------|----------|--------------------------------------|
| `cmd`      | `"branch"`   | yes      | Command discriminator                |
| `key`      | string       | yes      | Session key                          |
| `entryId`  | string       | yes      | Conversation entry ID to branch from |
| `requestId`| string       | no       | Correlates with ServerResult         |

```json
{"cmd":"branch","key":"abc-123","entryId":"entry-7","requestId":"r8"}
```

**Response:** `ServerResult` with `ok: true` on success.

---

### navigate_tree

Navigate to a different node in the conversation tree.

| Field      | Type               | Required | Description                   |
|------------|--------------------|----------|-------------------------------|
| `cmd`      | `"navigate_tree"`  | yes      | Command discriminator         |
| `key`      | string             | yes      | Session key                   |
| `targetId` | string             | yes      | Target node ID to navigate to |
| `requestId`| string             | no       | Correlates with ServerResult  |

```json
{"cmd":"navigate_tree","key":"abc-123","targetId":"node-3","requestId":"r9"}
```

**Response:** `ServerResult` with `ok: true` on success.

---

### get_tree

Retrieve the conversation tree structure for a session.

| Field      | Type          | Required | Description              |
|------------|---------------|----------|--------------------------|
| `cmd`      | `"get_tree"`  | yes      | Command discriminator    |
| `key`      | string        | yes      | Session key              |
| `requestId`| string        | no       | Correlates with ServerResult |

```json
{"cmd":"get_tree","key":"abc-123","requestId":"r10"}
```

**Response:** `ServerResult` with `data` containing the tree structure.

---

### dialog_response

Respond to a dialog prompt from the engine. Fire-and-forget.

| Field      | Type                | Required | Description                      |
|------------|---------------------|----------|----------------------------------|
| `cmd`      | `"dialog_response"` | yes      | Command discriminator            |
| `key`      | string              | yes      | Session key                      |
| `dialogId` | string              | yes      | ID of the dialog being answered  |
| `value`    | any                 | no       | Response value                   |

```json
{"cmd":"dialog_response","key":"abc-123","dialogId":"d1","value":"confirmed"}
```

---

### command

Send a slash command to the session's extension harness. Fire-and-forget.

| Field     | Type        | Required | Description                        |
|-----------|-------------|----------|------------------------------------|
| `cmd`     | `"command"` | yes      | Command discriminator              |
| `key`     | string      | yes      | Session key                        |
| `command` | string      | yes      | The command name (without slash)   |
| `args`    | string      | no       | Command arguments as a string      |

```json
{"cmd":"command","key":"abc-123","command":"clear","args":""}
```

---

### permission_response

Respond to a permission request from the engine. Fire-and-forget.

| Field        | Type                    | Required | Description                      |
|--------------|-------------------------|----------|----------------------------------|
| `cmd`        | `"permission_response"` | yes      | Command discriminator            |
| `key`        | string                  | yes      | Session key                      |
| `questionId` | string                  | yes      | ID from the permission request   |
| `optionId`   | string                  | yes      | ID of the chosen permission option |

```json
{"cmd":"permission_response","key":"abc-123","questionId":"q1","optionId":"allow_once"}
```

---

### shutdown

Shut down the engine daemon. Stops all sessions and closes all connections.

| Field | Type         | Required | Description           |
|-------|--------------|----------|-----------------------|
| `cmd` | `"shutdown"` | yes      | Command discriminator |

```json
{"cmd":"shutdown"}
```

No response is sent. The connection closes when the engine exits.

---

### list_stored_sessions

List saved sessions from disk.

| Field      | Type                     | Required | Description                     |
|------------|--------------------------|----------|---------------------------------|
| `cmd`      | `"list_stored_sessions"` | yes      | Command discriminator           |
| `limit`    | number                   | no       | Max results to return (default 50) |
| `requestId`| string                  | no       | Correlates with ServerResult    |

```json
{"cmd":"list_stored_sessions","limit":20,"requestId":"r11"}
```

**Response:** `ServerResult` with `data` containing an array of `StoredSessionInfo` objects.

**StoredSessionInfo fields:**

| Field          | Type   | Description                          |
|----------------|--------|--------------------------------------|
| `sessionId`    | string | Session identifier                   |
| `model`        | string | Model used                           |
| `createdAt`    | number | Unix timestamp (milliseconds)        |
| `messageCount` | number | Total messages in the session        |
| `totalCost`    | number | Total cost in USD                    |
| `firstMessage` | string | First user message (truncated)       |
| `lastMessage`  | string | Last message (truncated)             |
| `customTitle`  | string | User-assigned label, if any          |

---

### load_session_history

Load conversation messages from a stored session.

| Field        | Type                      | Required | Description                           |
|--------------|---------------------------|----------|---------------------------------------|
| `cmd`        | `"load_session_history"`  | yes      | Command discriminator                 |
| `key`        | string                    | conditional | Session key (provide this or `sessionIds`) |
| `sessionIds` | string[]                  | conditional | Ordered session IDs for chain loading |
| `requestId`  | string                    | no       | Correlates with ServerResult          |

Provide either `key` (load a single session) or `sessionIds` (load a chain of sessions in order). At least one must be present.

```json
{"cmd":"load_session_history","key":"abc-123","requestId":"r12"}
```

```json
{"cmd":"load_session_history","sessionIds":["s1","s2","s3"],"requestId":"r13"}
```

**Response:** `ServerResult` with `data` containing an array of `SessionMessage` objects.

**SessionMessage fields:**

| Field       | Type   | Description                   |
|-------------|--------|-------------------------------|
| `role`      | string | `"user"` or `"assistant"`     |
| `content`   | string | Message text                  |
| `toolName`  | string | Tool name, if a tool call     |
| `toolId`    | string | Tool use ID                   |
| `toolInput` | string | Serialized tool input         |
| `timestamp` | number | Unix timestamp (milliseconds) |

---

### save_session_label

Save a custom label for a session.

| Field      | Type                   | Required | Description              |
|------------|------------------------|----------|--------------------------|
| `cmd`      | `"save_session_label"` | yes      | Command discriminator    |
| `key`      | string                 | yes      | Session key              |
| `label`    | string                 | yes      | Label text               |
| `requestId`| string                | no       | Correlates with ServerResult |

```json
{"cmd":"save_session_label","key":"abc-123","label":"Refactor auth module","requestId":"r14"}
```

**Response:** `ServerResult` with `ok: true` on success.
