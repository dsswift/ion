---
title: Client Commands
description: Client commands in the Ion Engine socket protocol.
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

| Field                       | Type     | Required | Description                          |
|-----------------------------|----------|----------|--------------------------------------|
| `cmd`                       | `"send_prompt"` | yes | Command discriminator               |
| `key`                       | string   | yes      | Session key                          |
| `text`                      | string   | yes      | The user's prompt text               |
| `model`                     | string   | no       | Model override for this prompt       |
| `maxTurns`                  | number   | no       | Max LLM turns for this run           |
| `maxBudgetUsd`              | number   | no       | Spending cap in USD                  |
| `extensionDir`              | string   | no       | Override extension directory         |
| `noExtensions`              | boolean  | no       | Disable extensions for this run      |
| `requestId`                 | string   | no       | Correlates with ServerResult         |
| `planMode`                  | boolean  | no       | Start this run in plan mode. See [Plan Mode](../sessions/lifecycle.md#plan-mode). |
| `planModeTools`             | string[] | no       | Override the tool allowlist for this plan-mode run. Defaults to `["Read","Grep","Glob","Agent","WebFetch","WebSearch"]`. |
| `planFilePath`              | string   | no       | Path of the plan file for this plan-mode run. The engine enforces write-only access to this file while plan mode is active. |
| `planModePrompt`            | string   | no       | Custom system prompt for plan mode. When non-empty, the engine uses this string verbatim instead of building the default from `buildPlanModePrompt`. See [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides). |
| `planModeReentry`           | boolean  | no       | When `true`, prepends re-entry guidance (read the existing plan before making changes). Set by the session manager when plan mode is re-enabled on a session that has a prior plan file. |
| `implementationPhase`       | boolean  | no       | Suppresses the `EnterPlanMode` sentinel-tool injection. Set on the "implement" half of a plan-then-implement flow so the model cannot re-propose plan-mode entry. See ADR-004. |
| `enterPlanModeDescription`  | string   | no       | Harness-supplied description prose for the `EnterPlanMode` sentinel tool. When non-empty, the engine forwards it verbatim as the tool description. Empty falls back to the engine's one-line neutral default. Per [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md). |
| `planModeSparseReminder`    | string   | no       | Harness-supplied text for the per-turn plan-mode sparse reminder. When non-empty, the engine injects this verbatim instead of building the reminder from the plan file. Empty inherits the engine default (`buildPlanModeSparseReminder`). See [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides). |
| `bashAllowlistAdditionsForThisPrompt` | string[] | no | Per-prompt additions to the plan-mode Bash command allowlist. The engine unions these with the session-scoped allowlist (`set_plan_mode.planModeAllowedBashCommands`) when building the run-time tool list, then drops them at run end — the session allowlist is never mutated. Intended carrier: slash commands whose YAML frontmatter declares additional bash permissions for one turn (e.g. `/ion--review-changes` needing `gh pr diff`). See § [`set_plan_mode` → Configuration layers](#set_plan_mode) for the three-layer composition model. |
| `compactTargetPercent`      | number   | no       | Post-compact target as a percentage of the context window. Overrides `engine.json` `compaction.targetPercent` for this prompt. |
| `compactMicroKeepTurns`     | number   | no       | Number of recent turns protected from micro-compaction. Overrides `compaction.microCompactKeep`. |
| `compactEnabled`            | boolean  | no       | Gate for proactive compaction on this prompt. `false` disables proactive compaction; reactive compaction still fires on provider errors. |
| `compactSummaryEnabled`     | boolean  | no       | Whether LLM-based summarization is used during compaction for this prompt. |
| `compactMemoryEnabled`      | boolean  | no       | Whether the background session memory summarizer is active for this prompt. |

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

| Field                          | Type               | Required | Description                          |
|--------------------------------|--------------------|----------|--------------------------------------|
| `cmd`                          | `"set_plan_mode"`  | yes      | Command discriminator                |
| `key`                          | string             | yes      | Session key                          |
| `enabled`                      | boolean            | yes      | Enable or disable plan mode          |
| `allowedTools`                 | string[]           | no       | Tools allowed during plan mode       |
| `planModeAllowedBashCommands`  | string[]           | no       | Bash command prefixes allowed in plan mode. Tri-valued — see semantics below. |
| `requestId`                    | string             | no       | Correlates with ServerResult         |

```json
{"cmd":"set_plan_mode","key":"abc-123","enabled":true,"allowedTools":["Read","Glob"],"planModeAllowedBashCommands":["gh","git log","git diff"],"requestId":"r7"}
```

**`planModeAllowedBashCommands` semantics.** The field is tri-valued and uses JSON's nil-vs-empty distinction to disambiguate intent without a new wire field:

| Wire value | Meaning |
|---|---|
| omitted (field absent) | **No change** to the session's existing allowlist. Use this on every `set_plan_mode` call that does not intend to touch the allowlist. |
| `[]` (empty array, explicit) | **Clear** the allowlist. Bash is then blocked entirely in plan mode, regardless of any prior state. |
| `["gh", "git log", …]` | **Replace** the allowlist with this set. |

**Bash allowlist matching.** When the resolved allowlist is non-empty, the engine includes the `Bash` tool in the plan-mode tool list but gates each call against the allowlist at execution time. Matching is token-based: each command is split on whitespace and the first N tokens must match an entry exactly. `"gh"` matches `gh pr view 123` but not `ghost`; `"git log"` matches `git log --oneline -10` but not `git status`. Comparison is case-sensitive. A blocked call returns an `IsError: true` tool result; the model sees the failure and can adjust.

**Configuration layers (three sources, lowest-to-highest precedence for the same scope, unioned for additions).** The Bash allowlist is composed from three sources at run time:

| Layer | Source | Scope | Semantics |
|---|---|---|---|
| 1. Engine config | `engine.json` → `limits.planModeAllowedBashCommands` | Session-wide default | Loaded at session start. Acts as the initial value of the session-scoped allowlist when no `set_plan_mode` call has overridden it. |
| 2. `set_plan_mode` wire command | `planModeAllowedBashCommands` field above | Session-wide override | Tri-valued per the table above (omitted = no change; `[]` = clear; non-empty = replace). The engine treats this layer as authoritative for the session — subsequent runs in the same session see whatever this layer last established (or the engine-config default if never set). |
| 3. Per-prompt additions | `send_prompt` → `bashAllowlistAdditionsForThisPrompt` | One prompt only | Transient. The engine unions these with the session-level result of layers 1 and 2 (de-duplicated, session-first order) for exactly one run. The session allowlist is **never** mutated by this layer; subsequent prompts see only the session-level result. Intended carrier: slash-command YAML frontmatter `allowed_bash_commands`. |

This separation lets harnesses (a) install a default fleet allowlist via `engine.json`, (b) carry user preferences via `set_plan_mode` from the desktop / iOS / wherever, and (c) grant per-turn permissions via slash commands without leaking those grants into the user's session state.

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
| `internal`  | bool (optional) | `true` when the message was injected by the engine for LLM steering (e.g. plan mode reminders, turn limit warnings). Clients should filter these from user-facing display. Absent or `false` for normal user/assistant messages. |

---

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

---

### resource_subscribe

Subscribe to resource updates for a specific kind. The engine streams a snapshot event immediately on subscribe, then delta events as the resource collection changes.

| Field            | Type                    | Required | Description                                                                  |
|------------------|-------------------------|----------|------------------------------------------------------------------------------|
| `cmd`            | `"resource_subscribe"`  | yes      | Command discriminator                                                        |
| `key`            | string                  | yes      | Session key                                                                  |
| `resourceKind`   | string                  | yes      | Resource kind to subscribe to (e.g. `"tasks"`, `"notifications"`). The sentinel `"*"` subscribes to every kind on the target broker — see [Wildcard subscription](#wildcard-subscription) below. |
| `resourceFilter` | ResourceFilter object   | no       | Optional filter applied to the subscription                                  |
| `resourceGlobal` | boolean                 | no       | When `true`, subscribes to the Manager-level global broker instead of the per-session broker. Default `false`. |
| `requestId`      | string                  | no       | Correlates with ServerResult                                                 |

```json
{"cmd":"resource_subscribe","key":"abc-123","resourceKind":"tasks","requestId":"r20"}
```

#### Wildcard subscription

The sentinel `resourceKind: "*"` subscribes to **every** resource kind on the target broker — every kind that has a producer registered now, plus every kind registered or published later. A consumer can therefore drop hardcoded kind lists entirely and receive whatever any extension declares.

- **Real kind in every envelope.** Each snapshot and delta still carries the real item `kind` (never `"*"`), so the consumer buckets items by their true kind.
- **Per-session wildcard** (`resourceGlobal` omitted/`false`): the engine aggregates an initial snapshot by querying every registered producer, delivering one snapshot per producing kind, then streams all future kinds' deltas. It never errors on "no producer" — a broker with zero producers yields zero snapshots and still receives future kinds.
- **Global wildcard** (`resourceGlobal: true`): a producer-less subscription across all kinds on the Manager-level broker. No initial producer query is performed (workspace-scoped resources published by clients may have no producer), so the subscriber receives the live delta stream only.
- **Pure data routing.** The wildcard is a routing addition; the engine encodes no render or UI policy. Exact-kind subscriptions are unchanged.

```json
{"cmd":"resource_subscribe","key":"abc-123","resourceKind":"*","requestId":"r20"}
```

**Response:** `ServerResult` with `data: { subscriptionId: string }`. Use `subscriptionId` to unsubscribe later.

---

### resource_unsubscribe

Tear down an active resource subscription.

| Field           | Type                      | Required | Description                                       |
|-----------------|---------------------------|----------|---------------------------------------------------|
| `cmd`           | `"resource_unsubscribe"`  | yes      | Command discriminator                             |
| `key`           | string                    | yes      | Session key                                       |
| `resourceSubId` | string                    | yes      | The `subscriptionId` returned by `resource_subscribe` |
| `requestId`     | string                    | no       | Correlates with ServerResult                      |

```json
{"cmd":"resource_unsubscribe","key":"abc-123","resourceSubId":"sub-001","requestId":"r21"}
```

**Response:** `ServerResult` with `ok: true`. Tears down subscriptions on both session and global brokers.

---

### resource_publish

Publish a resource operation from the client. Routes to the global broker when `resourceItem.conversationId` is empty, to the session broker otherwise. Uses `PublishDirect` — no registered producer is required.

| Field          | Type                    | Required | Description                                                                      |
|----------------|-------------------------|----------|----------------------------------------------------------------------------------|
| `cmd`          | `"resource_publish"`    | yes      | Command discriminator                                                            |
| `key`          | string                  | yes      | Session key                                                                      |
| `resourceKind` | string                  | no       | Resource kind (informational; the kind is carried on `resourceItem`)             |
| `resourceOp`   | string                  | yes      | Operation: one of `"create"`, `"update"`, `"delete"`, `"mark_read"`              |
| `resourceItem` | ResourceItem object     | no       | The resource item to publish                                                     |
| `requestId`    | string                  | no       | Correlates with ServerResult                                                     |

```json
{"cmd":"resource_publish","key":"abc-123","resourceOp":"update","resourceItem":{"id":"item-1","conversationId":"conv-1"},"requestId":"r22"}
```

**Response:** `ServerResult` with `ok: true`.

---

### query_session_status

Request an immediate `engine_session_status` emission for a session. The status is emitted on the session's event stream, not as the RPC result. Useful for freshly reconnected clients that need current status without waiting for the next heartbeat.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"query_session_status"` | yes | Command discriminator |
| `key` | string | yes | Session key |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"query_session_status","key":"abc-123","requestId":"r30"}
```

**Response:** `ServerResult` with `ok: true`. The session status arrives as an `engine_session_status` event on the stream.

---

### delete_stored_sessions

Remove stale conversation files from disk. All filter fields are optional with sane defaults.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"delete_stored_sessions"` | yes | Command discriminator |
| `maxAgeDays` | number | no | Delete conversations older than this many days (default: 14) |
| `excludeIds` | string[] | no | Conversation IDs to keep regardless of age |
| `dryRun` | boolean | no | When `true`, report what would be deleted without deleting (default: `false`) |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"delete_stored_sessions","maxAgeDays":30,"excludeIds":["conv-important"],"dryRun":true,"requestId":"r31"}
```

**Response:** `ServerResult` with `data: { deleted: number, totalSize: number, dryRun: boolean }`.
