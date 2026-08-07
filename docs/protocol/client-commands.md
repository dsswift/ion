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
| `thinking`         | object   | no       | Extended thinking config (`enabled`, `effort`, `budgetTokens`, `streamDeltas`, `persist`). A per-session default that overrides the engine-wide [`thinking` block in `engine.json`](../configuration/engine-json.md#thinking) and is itself overridden by a per-prompt `thinkingEffort`. |
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
| `planModePrompt`            | string   | no       | Custom system prompt for plan mode. When non-empty, the engine uses this string verbatim instead of building the default from `buildPlanModePrompt`. On the codex backend it is sent as the plan collaboration mode's `developer_instructions` (a generic engine default applies when empty). See [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides) and [Plan mode on delegated-CLI backends](../sessions/lifecycle.md#plan-mode-on-delegated-cli-backends). |
| `planModeReentry`           | boolean  | no       | When `true`, prepends re-entry guidance (read the existing plan before making changes). Set by the session manager when plan mode is re-enabled on a session that has a prior plan file. |
| `implementationPhase`       | boolean  | no       | Suppresses the `EnterPlanMode` sentinel-tool injection. Set on the "implement" half of a plan-then-implement flow so the model cannot re-propose plan-mode entry. See ADR-004. |
| `thinkingEffort`            | string   | no       | Per-prompt extended-thinking effort for this run: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"` (ascending), or `"adaptive"` to request reasoning while letting a self-regulating model choose its own depth. A live per-conversation control — a client changes the level and it takes effect on the very next prompt with no session restart (mirrors `implementationPhase`). **Three distinct states.** A level sets thinking for the run. The literal `"off"` **clears** it, beating both the session default and the engine-wide [`engine.json` default](../configuration/engine-json.md#thinking). An **absent** field means "no opinion" and inherits whichever default is configured — so a client that wants thinking off must send `"off"` rather than omitting the field, or it will inherit the default. The engine maps a level onto `RunOptions.Thinking`; the provider then resolves the per-model mechanism (Anthropic adaptive `effort`, OpenAI `reasoning_effort`, Gemini `thinkingConfig`). A model that declares no thinking mechanism receives no directive. See the [model capability fields](../configuration/models.md#providersidmodelsname) (`thinkingMode` / `thinkingEfforts`) a client uses to decide whether to offer this control. |
| `enterPlanModeDescription`  | string   | no       | Harness-supplied description prose for the `EnterPlanMode` sentinel tool. When non-empty, the engine forwards it verbatim as the tool description. Empty falls back to the engine's one-line neutral default. Per [ADR-004](../architecture/adr/004-enter-plan-mode-prose-in-harness.md). |
| `planModeSparseReminder`    | string   | no       | Harness-supplied text for the per-turn plan-mode sparse reminder. When non-empty, the engine injects this verbatim instead of building the reminder from the plan file. Empty inherits the engine default (`buildPlanModeSparseReminder`). See [Plan mode prose overrides](../sessions/lifecycle.md#plan-mode-prose-overrides). |
| `bashAllowlistAdditionsForThisPrompt` | string[] | no | Per-prompt additions to the plan-mode Bash command allowlist. The engine unions these with the session-scoped allowlist (`set_plan_mode.planModeAllowedBashCommands`) when building the run-time tool list, then drops them at run end — the session allowlist is never mutated. Intended carrier: slash commands whose YAML frontmatter declares additional bash permissions for one turn (e.g. `/ion--review-changes` needing `gh pr diff`). See § [`set_plan_mode` → Configuration layers](#set_plan_mode) for the three-layer composition model. |
| `compactTargetPercent`      | number   | no       | Post-compact target. Auto/reactive passes apply it to the context window; explicit `/compact` applies it to the currently truncatable message estimate. Overrides `engine.json` `compaction.targetPercent` for this prompt. |
| `compactMicroKeepTurns`     | number   | no       | Number of recent turns protected from micro-compaction. Overrides `compaction.microCompactKeep`. |
| `compactEnabled`            | boolean  | no       | Gate for proactive compaction on this prompt. `false` disables proactive compaction; reactive compaction still fires on provider errors. |
| `compactSummaryEnabled`     | boolean  | no       | Whether LLM-based summarization is used during compaction for this prompt. |
| `compactMemoryEnabled`      | boolean  | no       | Whether the background session memory summarizer is active for this prompt. |
| `resolveSlash`              | boolean  | no       | When `true`, signals that `text` is a slash-command invocation (`/name args`) the engine should resolve and expand rather than treat as plain content. The engine looks the command up across the conventional roots in precedence order — `{workingDir}/.ion/commands`, `~/.ion/commands`, `{workingDir}/.ion/skills/<name>/SKILL.md`, `~/.ion/skills/<name>/SKILL.md`, then (only when Claude compatibility is enabled) `{workingDir}/.claude/commands`, `~/.claude/commands`, `~/.claude/skills/<name>/SKILL.md` — substitutes `$ARGUMENTS`, feeds the **expanded** body to the model (SKILL.md bodies are prefixed with their base directory so relative companion files resolve), and persists the **raw** invocation as the displayed user turn. Default `false`; existing clients sending `/`-prefixed content as ordinary text are unaffected because they do not set this flag. |

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
| `planFilePath`                 | string             | no       | Existing plan file path to **restore** when enabling plan mode. When `enabled` is true, the session currently has no plan file path, and this path exists on disk, the engine re-adopts it instead of allocating a fresh slug on the next prompt — preserving plan-file continuity after a session is replaced (e.g. rebound from the binding store). Ignored when the session already has a path, when the file is not on disk, or when `enabled` is false. Omit it when the client does not track a plan path (preserves prior behavior). |
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
| 1. Engine config | `engine.json` → `limits.planModeAllowedBashCommands` | Session-wide default | **Resolved fresh at each prompt dispatch** from `engine.json` (global `~/.ion/engine.json`, then project `.ion/engine.json`, enterprise-sealed), not cached at daemon start. An operator editing the list mid-conversation sees it honored on the **next prompt with no daemon restart**. Tri-valued: an explicit `[]` means "block Bash entirely in plan mode"; an absent field falls back to the boot-cached config, else Bash is blocked (the engine ships no built-in list). This layer is the allowlist a headless consumer with no client receives. Used only when layer 2 sent no override. |
| 2. `set_plan_mode` wire command | `planModeAllowedBashCommands` field above | Session-wide override | Tri-valued per the table above (omitted = no change; `[]` = clear; non-empty = replace). When set, the engine treats this layer as authoritative for the session and it wins over layer 1. **Kept for external consumers that choose to push an allowlist**; the in-repo reference desktop no longer sends it — it edits `engine.json` directly (layer 1) instead, so the allowlist stays engine-owned policy rather than client-pushed state. |
| 3. Per-prompt additions | `send_prompt` → `bashAllowlistAdditionsForThisPrompt` | One prompt only | Transient. The engine unions these with the session-level result of layers 1 and 2 (de-duplicated, session-first order) for exactly one run. The session allowlist is **never** mutated by this layer; subsequent prompts see only the session-level result. Intended carrier: slash-command YAML frontmatter `allowed_bash_commands`. |

This separation lets harnesses (a) install the allowlist as engine policy via `engine.json` — edited directly, resolved fresh per dispatch, and served identically to headless consumers, (b) optionally push a session override via `set_plan_mode` (external consumers only; the reference desktop edits `engine.json`), and (c) grant per-turn permissions via slash commands without leaking those grants into the user's session state.

**Layer 0: the enterprise ceiling.** When enterprise config sets `limits.planModeAllowedBashCommands`, the composed result of all three layers above is intersected against it before the run's tool list and gate are built. This is not a fourth precedence step but a cap applied over the outcome — layers 1-3 can only ever narrow within what policy permits, never widen past it.

The clamp deliberately covers layers 2 and 3, not just the config layer. Those two are client-supplied and therefore the easier paths to abuse: a ceiling that bound only `engine.json` would leave a `set_plan_mode` override or a slash command's `allowed_bash_commands` frontmatter free to grant commands the organisation forbids. Absent an enterprise policy the clamp is a pass-through.

Note that layer 1 merges the user and project `engine.json` files **additively** (union, de-duplicated) rather than by replacement, so a project can contribute commands its workflow needs on top of the developer's global list. See [Sealed Configuration → Plan-mode Bash allowlist](../enterprise/sealed-config.md#plan-mode-bash-allowlist) for the full model, including the prefix-matching direction rule.

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

### elicitation_response

Reply to an `engine_elicitation_request` event. Fire-and-forget; no result is sent. The engine pairs the reply to the waiting `ctx.elicit()` call using `elicitRequestId` and resolves the extension's Promise with either the response payload or the cancelled flag.

| Field             | Type    | Required | Description                                                                 |
|-------------------|---------|----------|-----------------------------------------------------------------------------|
| `cmd`             | `"elicitation_response"` | yes | Command discriminator                                          |
| `key`             | string  | yes      | Session key                                                                 |
| `elicitRequestId` | string  | yes      | Correlator echoed from the `engine_elicitation_request` `requestId` field   |
| `elicitResponse`  | object  | no       | The user's response payload, conforming to the `schema` from the request. Omit when cancelling. |
| `elicitCancelled` | boolean | no       | Set `true` when the user dismissed the prompt without submitting a response. |

```json
{"cmd":"elicitation_response","key":"abc-123","elicitRequestId":"elicit-001","elicitResponse":{"confirm":true}}
```

```json
{"cmd":"elicitation_response","key":"abc-123","elicitRequestId":"elicit-001","elicitCancelled":true}
```

---

### discover_slash_commands

Discover filesystem slash-command templates and skills available across the conventional roots for a working directory. Stateless -- no session key is required.

| Field       | Type                          | Required | Description                                                                                                                       |
|-------------|-------------------------------|----------|-----------------------------------------------------------------------------------------------------------------------------------|
| `cmd`       | `"discover_slash_commands"`   | yes      | Command discriminator                                                                                                             |
| `path`      | string                        | no       | Working directory. User-level roots are always included; this field adds project-level roots scoped to the given directory.        |
| `config`    | object                        | no       | Optional config object. When `claudeCompat` is `false` or absent, the engine skips `.claude` / `~/.claude` roots, matching the slash-resolution and skill-loading gates. |
| `requestId` | string                        | no       | Correlates with ServerResult                                                                                                      |

```json
{"cmd":"discover_slash_commands","path":"/home/user/project","config":{"claudeCompat":false},"requestId":"r40"}
```

**Response:** `ServerResult` with `data` containing an array of `SlashCommandListing` objects.

**SlashCommandListing fields:**

| Field           | Type   | Description                                                                          |
|-----------------|--------|--------------------------------------------------------------------------------------|
| `name`          | string | Command name (without the leading slash)                                             |
| `description`   | string | One-line description from the template frontmatter, if present                       |
| `argumentHint`  | string | Argument hint string, if present                                                     |
| `source`        | string | Where the template lives: `"ion"`, `"claude"`, or `"skill"`                         |

Higher-precedence roots shadow same-name entries in lower-precedence roots. The walk order matches slash resolution: `{workingDir}/.ion/commands`, `~/.ion/commands`, `{workingDir}/.ion/skills`, `~/.ion/skills`, then (Claude compatibility only) `{workingDir}/.claude/commands`, `~/.claude/commands`, `~/.claude/skills`. The `.ion` roots are the product's defaults and are never gated. Commands and skills are listed by default; a template with `user-invocable: false` frontmatter is omitted from the feed (typed resolution is not gated). The engine owns the discovery walk so every consumer's autocomplete menu is fed by one owner with no per-consumer filesystem walk.

---

### get_enterprise_policy

Read the enterprise `NewConversationDefaults` policy so clients can decide whether the new-conversation flow is locked. Stateless -- no session key is required.

| Field       | Type                       | Required | Description                  |
|-------------|----------------------------|----------|------------------------------|
| `cmd`       | `"get_enterprise_policy"`  | yes      | Command discriminator        |
| `requestId` | string                     | no       | Correlates with ServerResult |

```json
{"cmd":"get_enterprise_policy","requestId":"r41"}
```

**Response:** `ServerResult` with `data`:

| Field                     | Type         | Description                                                                                                   |
|---------------------------|--------------|---------------------------------------------------------------------------------------------------------------|
| `newConversationDefaults` | object\|null | The enterprise `NewConversationDefaults` policy object, or `null` when no enterprise config is loaded or no `NewConversationDefaults` section is present. |

```json
{"cmd":"result","requestId":"r41","ok":true,"data":{"newConversationDefaults":null}}
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

### resource_get

Fetch a single resource item's full content on demand from the registered producer. The engine emits an `engine_resource_item` event on the requesting connection when the item is found, then sends a successful `ServerResult`. When the item is not found or no producer is registered for the kind, the engine returns an error `ServerResult` and no event is emitted.

This is the lazy-fetch counterpart to `resource_subscribe`. It allows clients to request full content only when the user taps or expands an item, rather than receiving all item bodies in every snapshot.

| Field            | Type                    | Required | Description                                                                 |
|------------------|-------------------------|----------|-----------------------------------------------------------------------------|
| `cmd`            | `"resource_get"`        | yes      | Command discriminator                                                       |
| `key`            | string                  | no       | Session key for per-session broker; omit or use `""` with `resourceGlobal` |
| `resourceKind`   | string                  | yes      | Kind of the item to fetch                                                   |
| `resourceId`     | string                  | yes      | ID of the item to fetch                                                     |
| `resourceGlobal` | boolean                 | no       | `true` to query the global (workspace-level) broker instead of per-session  |
| `requestId`      | string                  | no       | Correlates with ServerResult                                                |

```json
{"cmd":"resource_get","key":"","resourceKind":"briefing","resourceId":"brief-42","resourceGlobal":true,"requestId":"r23"}
```

**Response event** (emitted before the `ServerResult` when the item is found):

```json
{"key":"","event":{"type":"engine_resource_item","resourceKind":"briefing","resourceItem":{"id":"brief-42","kind":"briefing","title":"Daily Brief","content":"Full briefing body…","createdAt":"2024-07-19T00:00:00Z"}}}
```

**Response:** `ServerResult` with `ok: true` on success, or `ok: false` with an error message when:
- No producer is registered for `resourceKind`.
- The producer returns no item for `resourceId`.
- The session key has no active broker (for per-session queries).

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

### get_context_breakdown

Request an on-demand context breakdown for a session. The engine reconstructs the full assembly pipeline (system prompt + tools + conversation messages) outside any active run and emits `engine_context_breakdown` on the event stream.

**Recompute model.** This command fires the same assembly pipeline that `send_prompt` runs before every prompt: it loads the conversation from disk, injects context files, extension context, git context, and session memory into `RunOptions`, then calls `BuildContextBreakdown`. The result always reflects the current on-disk state — it is never cached or persisted.

**Fresh conversations.** When the session has not sent its first prompt yet, the conversation file may not exist. The engine falls back to an empty conversation, so the breakdown shows system prompt + tools with zero conversation tokens. This is the accurate pre-first-prompt view.

**CliBackend.** When the session is wired to a CliBackend (no API provider), the token counter falls back to local BPE / char4 estimation. The breakdown is still emitted.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"get_context_breakdown"` | yes | Command discriminator |
| `key` | string | yes | Session key |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"get_context_breakdown","key":"abc-123","requestId":"r31"}
```

**Response:** `ServerResult` with `ok: true` (empty). The breakdown arrives as an `engine_context_breakdown` event on the stream. If no session exists for the key, the command is a no-op (Warn log fires engine-side).

**Payload fields (`ContextBreakdownPayload`).**

| Field | Type | Description |
|-------|------|-------------|
| `categories` | array | Per-category token rows. Each row has `name`, `kind`, `tokens`, `tier` ("exact"/"local"/"approximate"), and optional `path`. |
| `contextWindow` | number | Maximum token budget for the model. |
| `occupancyTokens` | number? | **The engine's authoritative context-window occupancy — divide this by `contextWindow` to render "how full is the context".** The same figure `StatusFields.contextTokens` carries and the same input the engine's proactive-compaction gate measures against its limit. Absent when the engine has no occupancy figure for the conversation. See "Which token count to use" below. |
| `totalTokens` | number | The **itemized** sum of all category token counts — an independent per-category estimate for *attribution* ("what is taking up the space"), not occupancy. Over-reports relative to `occupancyTokens`: it counts content the provider did not bill for this turn. |
| `apiReportedTotal` | number? | Provider-reported input token count for the most recent turn. Zero until after-first-turn reconciliation. Under-reports mid-turn: it excludes messages appended since that turn (e.g. tool results not yet sent). |
| `unaccounted` | number? | `apiReportedTotal - totalTokens`. Non-zero after reconciliation. |
| `cacheReadTokens` | number? | Provider-reported cache-read tokens. Annotation only — NOT included in `totalTokens`. |
| `cacheCreationTokens` | number? | Provider-reported cache-creation tokens. Annotation only — NOT included in `totalTokens`. |
| `model` | string | Model identifier used for tokenization. |
| `aggregateCostUsd` | number? | Sum of this session's LLM cost **plus every descendant dispatch session's cost**, walked on demand from the conversation tree. Absent for sessions with no dispatches or no cost yet. See "Aggregate cost model" below. |

**Which token count to use.** Three fields carry token totals and they answer different questions. For a context-fullness indicator (a ring, a bar, a percentage) use **`occupancyTokens`** — it is what the engine itself measures for compaction, so a consumer rendering it agrees with `engine_status` by construction. Use `totalTokens` and the `categories` rows for attribution UI, where the `unaccounted` row makes the itemized sum's drift from the provider total explicit. Use `apiReportedTotal` when you specifically want the provider's own last-turn accounting.

Deriving occupancy from either of the other two produces a wrong figure in opposite directions: `totalTokens` over-reports (one conversation occupying 26% of a 1M window itemized at ~103% of it), and `apiReportedTotal` under-reports for the duration of any in-flight turn.

**Aggregate cost model.** `aggregateCostUsd` is recomputed on every `get_context_breakdown` request — no accumulator, no persistence. The engine reads each session's persisted `totalCost` from its `.llm.jsonl` header, then recursively follows `AgentDispatchData.ConversationIDs` entries in the parent's `.tree.jsonl` to collect every descendant dispatch session. In-flight background dispatches (not yet written to `.tree.jsonl`) are also included via the live dispatch registry, as of their last cost flush. Each conversation ID is counted at most once (cycle/dup guard). A mid-turn child may undercount by its unflushed turn — this self-heals on the next drawer-open after the child's next flush.

Two cost numbers in the Status Drawer are intentionally distinct: the Context section shows the **per-run cost only** (`StatusFields.runCostUsd`), while the Session section shows the **end-to-end aggregate** (`conversationCostUsd` / `aggregateCostUsd`). When there are no descendant dispatches, the two are equal.

**iOS companion.** iOS sends `desktop_request_context_breakdown { tabId }` to the desktop on drawer open. The desktop's `command-handler.ts` forwards a `get_context_breakdown` to the engine for that tab. The resulting `engine_context_breakdown` is forwarded to iOS as `desktop_context_breakdown` by `event-wiring.ts`, which populates `inst.contextBreakdown` and re-renders the Status Drawer. This is the on-demand recompute model: no persistence, no stale cache — every drawer open triggers a fresh computation.

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

---

### oidc_begin_login

Start an operator OIDC login. The engine owns the operator's OIDC identity; this command begins a grant flow and returns only the user-facing half the consumer must surface. The flow completes engine-side (or via background polling for device-code); completion broadcasts an `engine_oidc_identity` snapshot to all clients. Requires an identity provider configured via `auth.identityProvider` in `engine.json`; without one, the command returns an error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"oidc_begin_login"` | yes | Command discriminator |
| `oidcFlow` | string | no | `"pkce"` (default when empty) runs the interactive authorization-code + PKCE flow; `"device"` runs the device-code flow for headless hosts |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"oidc_begin_login","oidcFlow":"device","requestId":"r40"}
```

**Response.** An `engine_oidc_login_url` event is delivered to the requesting client with the flow's user-facing half. The `ServerResult` payload mirrors it:
- PKCE flow: `{ authorizationUrl }`.
- Device-code flow: `{ userCode, verificationUri, expiresIn }`.

Login completion is asynchronous: the engine polls (device) or awaits the loopback callback (PKCE) in the background and broadcasts `engine_oidc_identity` when it lands.

---

### oidc_logout

Sign the operator out and broadcast the signed-out identity snapshot to all clients. Requires a configured identity provider.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"oidc_logout"` | yes | Command discriminator |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"oidc_logout","requestId":"r41"}
```

**Response:** `ServerResult` with `ok: true` (empty data). A follow-up `engine_oidc_identity` snapshot (with `oidcSignedIn: false`) is broadcast to all clients.

---

### oidc_identity

Request the current operator identity snapshot. Requires a configured identity provider.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"oidc_identity"` | yes | Command discriminator |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"oidc_identity","requestId":"r42"}
```

**Response.** An `engine_oidc_identity` event is delivered to the requesting client. The `ServerResult` payload mirrors it: `{ signedIn: boolean, subject, username, name, provider }`.

---

### oidc_token

Mint a short-lived access token for the requested scope and return it in the result payload — **requester-only delivery, never broadcast**. This is the seam that lets a trusted local client authenticate downstream calls without owning the grant: the refresh token never leaves the engine; clients pull ephemeral access tokens on demand. Requires a configured identity provider and a signed-in operator.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"oidc_token"` | yes | Command discriminator |
| `oidcScope` | string | no | Downstream resource scope for the minted token (e.g. `api://<app-id>/Telemetry.Write`). Empty uses the operator grant's base scope. |
| `oidcAudience` | string | no | Explicit audience/resource for the minted token, for IdPs that bind grants to one (Auth0, RFC 8707) instead of encoding the resource in the scope string. Empty uses the provider's configured default audience. |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"oidc_token","oidcScope":"api://app-id/Telemetry.Write","requestId":"r43"}
```

**Response:** `ServerResult` with `data: { accessToken: string }`. The token is bounded (30 s mint deadline) and returned only to the requesting connection.

---

### plugin_install

Download and install a Claude Code-compatible plugin from a GitHub source (`"owner/repo"`). The `source` field carries the repo path.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"plugin_install"` | yes | Command discriminator |
| `source` | string | yes | GitHub source path (`"owner/repo"`) |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"plugin_install","source":"owner/repo","requestId":"r44"}
```

**Response:** `ServerResult` with `data: { name, source, version }` describing the installed plugin.

---

### plugin_list

List all installed plugins.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"plugin_list"` | yes | Command discriminator |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"plugin_list","requestId":"r45"}
```

**Response:** `ServerResult` with `data` as a JSON array of plugin records, each `{ name, source, version, installedAt }`.

---

### plugin_remove

Uninstall a plugin by name. The `label` field carries the plugin name to remove.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"plugin_remove"` | yes | Command discriminator |
| `label` | string | yes | Name of the plugin to remove |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"plugin_remove","label":"my-plugin","requestId":"r46"}
```

**Response:** `ServerResult` with `data: { removed: string }` echoing the removed plugin name.

---

### provider_login

Start an interactive login for a provider's delegated CLI (`anthropic` → claude-code, `openai` → codex, `xai` → grok, `cursor` → cursor). The engine resolves the CLI kind, drives the flow in the background, and broadcasts [`engine_provider_login`](server-events.md#engine_provider_login) stage events. **The socket never blocks:** the command returns as soon as the flow is started. A provider with no delegated CLI returns an error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"provider_login"` | yes | Command discriminator |
| `provider` | string | yes | Provider ID whose CLI should authenticate |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"provider_login","provider":"anthropic","requestId":"r47"}
```

**Response:** `ServerResult` with `data: { started: true, backend: string }` naming the CLI kind driving the flow.

Starting a login for a provider that already has one in flight cancels the previous one. On completion the engine re-probes the CLI and broadcasts `engine_providers_updated`, so consumers re-query `list_models` rather than assuming the new auth state.

---

### provider_login_code

Return a browser-issued authorization code to a login parked on the `await_auth_code` stage. Required by flows the engine drives through a CLI's manual-paste fallback rather than its own callback: the provider hands the user a code in the browser and the CLI waits for it on stdin, so the consumer must carry it back.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"provider_login_code"` | yes | Command discriminator |
| `provider` | string | yes | Provider whose parked login the code belongs to |
| `text` | string | yes | The authorization code |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"provider_login_code","provider":"anthropic","text":"<code>","requestId":"r48"}
```

**Response:** `ServerResult` with `data: { delivered: true }`. Returns an error when the provider has no in-flight login, or when a code was already supplied for it.

The code is a bearer-grade secret. The engine logs only its length, never its value; consumers should do the same. Each parked login accepts exactly one code, and codes are scoped to their own login — a code sent for one provider can never reach another provider's flow.

---

### provider_login_cancel

Abort an in-flight login for a provider. Cancels the driver's context, which terminates the CLI subprocess (and for codex, sends `account/login/cancel`).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"provider_login_cancel"` | yes | Command discriminator |
| `provider` | string | yes | Provider whose login should be aborted |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"provider_login_cancel","provider":"anthropic","requestId":"r49"}
```

**Response:** `ServerResult` with `data: { cancelled: boolean }` — `false` when no login was in flight for that provider.

---

### provider_logout

Clear the provider CLI's stored credential and re-probe so the provider reflects the signed-out state. Supported for the CLIs that expose a logout surface (codex via its app-server, claude-code via `claude auth logout`); the ACP agents manage their own credential store and return an error.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"provider_logout"` | yes | Command discriminator |
| `provider` | string | yes | Provider whose CLI credential should be cleared |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"provider_logout","provider":"anthropic","requestId":"r50"}
```

**Response:** `ServerResult` with `data: { ok: true }`. The logout itself runs in the background and is bounded, so the result acknowledges dispatch rather than completion. A completed logout emits no login-stage event — `engine_providers_updated` is the only signal, so consumers must handle it to notice.

---

### resolve_model_tier

Resolve a tier name from [`~/.ion/models.json`](../configuration/models.md#tiers) to the model it is configured for, plus that tier's fallback chain.

The engine owns that file's semantics, so consumers ask rather than parsing it themselves. This matters most for a consumer that *gates a feature* on a tier existing: resolution is a pass-through for an unrecognised name. When no provider resolves that name, a run falls back to its configured default model and emits `engine_model_fallback`; the resolved value alone still cannot distinguish "configured" from "unknown". The `configured` flag is that distinction.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"resolve_model_tier"` | yes | Command discriminator |
| `text` | string | yes | Tier name to resolve (case-insensitive) |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"resolve_model_tier","text":"standard","requestId":"r51"}
```

**Response:** `ServerResult` with `data: { tier: string, model: string, fallbacks: string[], configured: boolean }`.

| Field | Meaning |
|-------|---------|
| `tier` | The requested name, echoed back |
| `model` | The configured model, or the tier name itself when the tier is not defined |
| `fallbacks` | Ordered fallback models, when the tier is declared in object form. Always a list — empty for a plain string tier and for an unconfigured one |
| `configured` | `false` when no such tier is defined. Treat `model` as meaningless in that case and refuse the gated operation, rather than dispatching a run that cannot route |

The command is rejected at parse time when `text` is absent or empty: the tier name is the entire request.

---

### list_model_tiers

Return a complete snapshot of configured model tiers. Each entry normalizes both supported `models.json` forms into `{ name, model, fallbacks }`; `fallbacks` is always a list.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"list_model_tiers"` | yes | Command discriminator |
| `requestId` | string | no | Correlates with ServerResult |

**Response:** `ServerResult` with `data: { tiers: Array<{ name: string, model: string, fallbacks: string[] }> }`. The requester also receives `engine_model_tiers`; it is a complete snapshot, so consumers replace local state rather than merge it.

---

### set_model_tier

Create or replace one tier. Names are normalized to lowercase. A tier with no fallbacks persists in compact string form; a tier with fallbacks persists as `{ "model": "...", "fallbacks": [...] }`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"set_model_tier"` | yes | Command discriminator |
| `text` | string | yes | Tier name |
| `model` | string | yes | Primary model |
| `fallbacks` | string[] | no | Ordered fallback models |
| `requestId` | string | no | Correlates with ServerResult |

Successful writes broadcast a complete `engine_model_tiers` snapshot to every connected client.

---

### remove_model_tier

Remove one configured tier.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"remove_model_tier"` | yes | Command discriminator |
| `text` | string | yes | Tier name |
| `requestId` | string | no | Correlates with ServerResult |

Successful removals broadcast a complete `engine_model_tiers` snapshot to every connected client. Removing an unknown tier returns an error.

---

### mcp_list

List configured MCP servers with their connection and authorization state.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"mcp_list"` | yes | Command discriminator |
| `path` | string | no | Project directory. Scopes the project config layer; global servers always resolve. |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"mcp_list","requestId":"r60"}
```

**Response.** An `engine_mcp_servers` event is delivered to the requesting client. The `ServerResult` payload mirrors it: `{ servers: McpServerStatus[] }`.

`connected` and `authenticated` are independent flags. A server that is authenticated but not connected has a stored token the server is refusing — consumers should not collapse the two into a single state.

---

### mcp_add

Add an MCP server to `~/.ion/engine.json`. Replaces any entry already stored under the same name. Only the `mcpServers` key is rewritten; every other key in the file, including keys newer than the running engine, is preserved.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"mcp_add"` | yes | Command discriminator |
| `mcpName` | string | yes | Server name (the key under `mcpServers`). Must not contain whitespace or `"__"`, which separates server and tool names. |
| `mcpTransport` | string | no | `http`, `sse`, `ws`, or `stdio`. Inferred when omitted: a URL means `http`, a command means `stdio`. |
| `mcpUrl` | string | network only | Endpoint for `http`/`sse`/`ws`. |
| `mcpCommand` | string | stdio only | Executable for a stdio server. |
| `mcpArgs` | string[] | no | Arguments for a stdio server. |
| `mcpEnv` | map[string]string | no | Environment variables for a stdio server's subprocess. |
| `mcpHeaders` | map[string]string | no | Static HTTP headers for a network transport. |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"mcp_add","mcpName":"mobbin","mcpUrl":"https://api.mobbin.com/mcp","requestId":"r61"}
```

**Response:** `ServerResult` with `data: { name, transport }`, then an `engine_mcp_servers` snapshot broadcast to every client.

Rejected with an error when the transport and endpoint contradict each other, or when enterprise policy (`mcpDenylist` / `mcpAllowlist`, including its URL-host globs) forbids the server. The policy check runs **before** the write, so a refused server is never persisted.

---

### mcp_remove

Remove a server from `engine.json` along with its stored credentials.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"mcp_remove"` | yes | Command discriminator |
| `mcpName` | string | yes | Server to remove |
| `path` | string | no | Project directory for the follow-up snapshot |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"mcp_remove","mcpName":"mobbin","requestId":"r62"}
```

**Response:** `ServerResult` with `data: { name }`, then an `engine_mcp_servers` broadcast. Removing a name that is not configured is an error rather than a silent success.

---

### mcp_login

Start the interactive OAuth flow for a server. **Returns immediately** with the authorization URL; the engine completes the exchange on a background goroutine, so the dispatch never holds the client's read loop while a human is in a browser.

The engine resolves the client in precedence order: an explicit `oauth` block in `engine.json`, then a stored dynamic registration, then discovery (RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata) followed by RFC 7591 dynamic client registration. It then runs authorization-code + PKCE against a loopback callback it owns and persists the grant.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"mcp_login"` | yes | Command discriminator |
| `mcpName` | string | yes | Server to authorize |
| `mcpScope` | string | no | OAuth scope to request, overriding what the server's metadata advertises |
| `path` | string | no | Project directory used to resolve the server |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"mcp_login","mcpName":"mobbin","requestId":"r63"}
```

**Response.** An `engine_mcp_login_url` event is delivered to the requesting client, and the `ServerResult` payload mirrors it: `{ name, authorizationUrl }`. The consumer opens that URL. When the flow settles, the engine reconnects the server across every live session and broadcasts `engine_mcp_servers` — on failure too, since the snapshot's `authenticated` flag is how a consumer learns the attempt left the server unauthorized.

---

### mcp_logout

Drop a server's stored token and client registration, leaving its configuration in place. The client registration goes too, so a later login registers fresh rather than reusing a client the operator believes was revoked.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cmd` | `"mcp_logout"` | yes | Command discriminator |
| `mcpName` | string | yes | Server to log out of |
| `path` | string | no | Project directory for the follow-up snapshot |
| `requestId` | string | no | Correlates with ServerResult |

```json
{"cmd":"mcp_logout","mcpName":"mobbin","requestId":"r64"}
```

**Response:** `ServerResult` with `data: { name }`, then an `engine_mcp_servers` broadcast.
