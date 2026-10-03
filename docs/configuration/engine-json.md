---
title: engine.json Reference
description: Complete field reference for Ion Engine's engine.json configuration file.
sidebar_position: 2
---

# engine.json Reference

This document covers every field in `engine.json`, used at both the user level (`~/.ion/engine.json`) and the project level (`.ion/engine.json`).

When enterprise policy names a [managed engine file](../enterprise/managed-config.md), the engine reads that file in place of both the user-level and the project-level file.

## Required configuration

Ion ships with no default model. Before the engine can run a prompt, you must either set `defaultModel` in `engine.json` or pass `--model` on the command line. You also need credentials for the provider that model maps to (a `*_API_KEY` env var, an entry under `providers.<id>.apiKey`, or no key at all if the provider is local). See [models.json Reference](models.md) for registering custom models and tier aliases.

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `"api"` | Backend mode. `"api"` for direct API calls, `"cli"` for CLI proxy. |
| `defaultModel` | string | `""` | Model identifier used when no `--model` override is passed. Required. The engine errors out if neither this field nor `--model` is set. |
| `logLevel` | string | `""` | Log verbosity. One of `"debug"`, `"info"`, `"warn"`, `"error"`. Empty string uses the engine default. |
| `slashModelTier` | object | omitted | Policy for command-owned model tiers after a conversation has history. See [slashModelTier](#slashmodeltier). |
| `subscriptionLookup` | object | omitted | Resolve a provider's key from an endpoint with the signed-in identity. See [subscriptionLookup](#subscriptionlookup). |
| `protectedOperations` | object | omitted | Named outbound calls whose secret the engine injects. Global file and enterprise config only. See [protectedOperations](#protectedoperations). |

## slashModelTier

Controls whether a slash command's `model:` tier may replace the serving model after the conversation has model-visible history.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `applyMidConversation` | boolean | `false` | When true, a command-owned tier can switch models after history exists. When false or omitted, the engine retains the current model to preserve its prompt cache. |

```json
{
  "slashModelTier": {
    "applyMidConversation": true
  }
}
```

A `slashModelTierApplyMidConversation` value on one `send_prompt` or `command` request overrides this block for that invocation. The `before_slash_model_boundary` hook has final say. Fresh conversations always apply the command tier because no history must be re-sent.

## runRecovery

Durable interrupted-run recovery. Omit block to preserve historical behavior: recovery off unless a client or extension enables it for session. Engine journals accepted recoverable work before dispatch. After engine restart, it resumes from durable checkpoint without appending original user prompt again.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | unset (`false` when no higher layer enables it) | Enable recovery default for sessions. |
| `maxAttempts` | integer | `2` after recovery is enabled | Maximum restart recovery attempts for one run. |
| `maxConcurrent` | integer | `2` | Maximum interrupted-run continuations the engine starts at one time after restart. This engine-wide cap uses FIFO admission; session and extension overrides cannot change it. |
Policy precedence, low to high: `engine.json`, `start_session` `EngineConfig.runRecovery`, extension `ext/set_run_recovery`. Session policy affects later runs only. It does not change an active run's journal.

```json
{
  "runRecovery": {
    "enabled": true,
    "maxAttempts": 3,
    "maxConcurrent": 2
  }
}
```

### Run journal lifecycle

The engine clears a run journal when that run reaches any terminal exit. A
journal stays only while work is still live, including a parked root run with
signal `suspended`; that parked run needs its journal for its engine-owned wake.
Journal cleanup is keyed to the run identity, so a late exit cannot clear a
newer queued run's journal.

## providers

Map of provider name to credentials. Keys are provider identifiers (e.g., `"anthropic"`, `"openai"`, `"groq"`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | `""` | API key. If the value is all uppercase letters and underscores (e.g., `"ANTHROPIC_API_KEY"`), the engine resolves it from the environment variable of that name. |
| `baseURL` | string | `""` | Custom API endpoint. Use this for proxies, gateways, or self-hosted providers. |
| `authHeader` | string | `""` | Custom authorization header name. Overrides the provider's default auth header. |
| `displayName` | string | `""` | Human-friendly name clients show for this provider (e.g. `"Corp Gateway"` for the provider id `corp-gateway`). Surfaced on the `list_models` `ProviderEntry` wire shape. Empty ⇒ clients fall back to their own built-in name map, then to the capitalized id. |

```json
{
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    },
    "openai": {
      "apiKey": "sk-proj-...",
      "baseURL": "https://gateway.example.com/v1"
    }
  }
}
```

## limits

Resource limits for agent runs. All fields are optional pointers -- omitting a field means "use the value from a lower config layer."

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxTurns` | int (nullable) | unset (unlimited) | Maximum number of LLM turns before the agent stops. Unset or `<= 0` means no cap. |
| `maxBudgetUsd` | float (nullable) | unset (unlimited) | Cost ceiling in USD. The agent stops when estimated spend reaches this value. Unset or `<= 0` means no cap. |
| `suppressSystemMessages` | bool (nullable) | unset (`false`) | When `true`, engine-injected steering messages are sent to the LLM in-memory but not persisted to the session conversation file. Default: unset (`false`). |
| `disablePlanModeReminder` | bool (nullable) | unset (`false`) | When `true`, the plan mode sparse reminder is not injected on turn 2+. Default: unset (`false`). Power users who want to customize the reminder text rather than suppress it entirely should see `RunOptions.PlanModeSparseReminder` in [client-commands.md](../protocol/client-commands.md#send_prompt) or the harness-level `desktop.planModeSparseReminder` key in [settings-json.md](./settings-json.md). |
| `disableTurnLimitWarning` | bool (nullable) | unset (`false`) | When `true`, the turn-limit wind-down message is not injected. Default: unset (`false`). |
| `disableMaxTokenContinue` | bool (nullable) | unset (`false`) | When `true`, the max-tokens continue prompt is not injected. Default: unset (`false`). |
| `planModeAllowedBashCommands` | string[] | unset (Bash blocked in plan mode) | Bash command prefixes permitted while in plan mode. **Merges additively across the user and project layers** rather than replacing, so a repository can declare the commands its workflow needs on top of each developer's global list. Tri-valued: omitted means "no opinion at this layer"; `[]` means "block Bash in plan mode" and beats a lower layer's list; a non-empty list is unioned. Capped by enterprise policy when present. See [Plan-mode Bash allowlist](limits.md#plan-mode-bash-allowlist). |

These can also be overridden per-session via CLI flags. See [Limits](limits.md) for details.

```json
{
  "limits": {
    "maxTurns": 100,
    "maxBudgetUsd": 25.0,
    "suppressSystemMessages": false,
    "disablePlanModeReminder": false,
    "disableTurnLimitWarning": false,
    "disableMaxTokenContinue": false,
    "planModeAllowedBashCommands": ["git log", "git diff", "ls"]
  }
}
```

### Project-level `limits` and portability

`planModeAllowedBashCommands` is the field where the project layer earns its keep. A checked-in `.ion/engine.json` cannot know what any individual developer allows globally, so replacement semantics would force every repo to either restate those entries or silently strip them. Union means the repo contributes only what it needs:

```jsonc
// <repo>/.ion/engine.json — committed, travels with every clone
{
  "limits": {
    "planModeAllowedBashCommands": ["graphify"]
  }
}
```

Every developer who clones the repository gains `graphify` in plan mode on top of their own global entries, with no per-machine setup. On a machine with enterprise policy, the same file is capped by the ceiling and contributes nothing the organisation has not sanctioned.

### Other project-scoped roots under `.ion/`

`.ion/engine.json` is not the only project-scoped artifact the engine reads from a session's working directory. Skills follow the same pattern:

| Path | Contents |
|---|---|
| `<workingDir>/.ion/engine.json` | Project config, merged over user config |
| `<workingDir>/.ion/skills/<name>/SKILL.md` | Project-scoped skills |

Project skills are **session-scoped**: they register into the registry of sessions whose working directory contains them, and are evicted when that session stops. A skill shipped in one repository is never advertised in another project's conversations, and two repositories may ship same-named skills without collision. User-scoped skills from `~/.ion/skills/` are copied into every session's registry rather than shared, so one session's teardown can never strip a skill another live session is using. See `engine/internal/skills/skills_session.go`.

Both roots make a repository self-describing: clone it and the project's config and skills arrive with it, with no per-machine install step.

## earlyStopContinue

Engine-wide configuration for the **early-stop continuation** mechanism. When the model emits `end_turn` (or `stop`) before reaching the configured output-token target, the engine can ask a harness-supplied hook whether to nudge the model to keep working and re-run the turn instead of completing the run. This addresses the "stream death / mid-thought stop" problem where some models voluntarily end a turn before the work is done.

The feature is **off by default**. The engine provides the mechanism (cumulative output-token tracking, `before_early_stop_decision` and `early_stop_continued` hooks, the re-run-turn machinery) but ships no opinion about whether to nudge or what text to nudge with. A continuation consumes the operator's tokens and pre-empts their choice to accept a stopped run and decide what to do next. A harness consumer must opt in — either by setting `enabled: true` in this block, by passing `RunOptions.EarlyStopEnabled = &true` per dispatch, or by wiring a `before_early_stop_decision` handler that returns `ForceContinue: &true`. Whichever turns the feature on, the harness must also supply a `ContinueMessage` via the hook — without one, the engine logs the no-op and falls through to normal completion.

See [ADR-002: Engine vs Harness for Early-Stop Continuation](../architecture/adr/002-engine-vs-harness-early-stop.md) for the full rationale behind the default-off, harness-owned-policy design.

Three resolution layers, lowest priority first:

1. This block (`engine.json` — host-level configuration).
2. Per-run `RunOptions` (a harness dispatching a single run; see the [Hook Reference](../hooks/reference.md)).
3. The `before_early_stop_decision` hook (programmatic, context-aware policy and the prompt text).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool (nullable) | `false` | Global gate. Set to `true` to enable the feature for every run on this machine. A harness still must supply a `ContinueMessage` through `before_early_stop_decision` for any injection to happen. |
| `budget` | int | `8000` | Output-token target per run. A run that ends at less than `thresholdPct` of this budget triggers the hook. Tune per typical agent output size. |
| `thresholdPct` | int | `90` | Completion threshold (percent of `budget`). Once cumulative output reaches this percent, `Eligible` is false and the reference policy stops nudging. |
| `maxContinuations` | int | `3` | Cap on the number of continuation nudges per run. Prevents pathological loops with very chatty models. |
| `diminishingDelta` | int | `500` | Per-continuation token delta below which the engine declares diminishing returns and stops nudging early (after at least 3 continuations). |
| `subagentEnabled` | bool (nullable) | `null` (off) | Whether the feature applies to **dispatched sub-agent runs** as well as root runs. Null preserves the historic behavior exactly: sub-agents are skipped unless a harness forces them on per dispatch. See "Sub-agents" below. |

```json
{
  "earlyStopContinue": {
    "enabled": true,
    "budget": 8000,
    "thresholdPct": 90,
    "maxContinuations": 3,
    "diminishingDelta": 500
  }
}
```

To **explicitly disable the built-in gate globally** (the default), leave `enabled` false. The decision hook still fires with `WouldContinue=false` and `Eligible` reporting whether the mechanical threshold, cap, and diminishing-returns safeguards permit another turn. A harness can opt in with `ForceContinue: &true`; with no such response, every `end_turn` completes normally:

```json
{
  "earlyStopContinue": {
    "enabled": false
  }
}
```

### Reference policy implementation

The Ion desktop client ships a reference `before_early_stop_decision` handler in `desktop/src/main/early-stop-policy.ts` that:

- Reads a user-facing `enableEarlyStopContinuation` setting (default `false`).
- Returns `ForceContinue: &true` plus a Claude-Code-style `ContinueMessage` ("Stopped at X% of token target …") when the setting is on and `Eligible` is true.
- Returns `ForceContinue: &false` when the setting is off, and no opinion when the mechanical safeguards report `Eligible=false`.

Harness engineers running the engine outside the Ion desktop are encouraged to copy or adapt this implementation. The engine deliberately ships no prompt text so the harness owns the wording (and the user-facing toggle, if any) end-to-end.

**Sub-agents are off by default.** Runs dispatched through the Agent tool have `IsSubagent=true` and the engine skips the feature for them — sub-agents are summoned with a tight remit and should not be poked to keep working. Harness extensions can force-on per dispatch via `RunOptions.EarlyStopEnabled = &true`.

Set `subagentEnabled: true` to opt the whole machine's dispatched agents into the feature instead of threading a per-run override through every dispatch site:

```json
{
  "earlyStopContinue": {
    "enabled": true,
    "subagentEnabled": true
  }
}
```

Two properties of this key matter:

- **It is a scope selector, not a second kill switch.** It decides whether the sub-agent *tier* participates; `enabled` still decides whether the feature runs at all. `subagentEnabled: true` with `enabled: false` nudges nothing.
- **Omitting it preserves today's behavior exactly**, which is what every `engine.json` already on disk does. A per-run `RunOptions.EarlyStopEnabled` still wins over both — a harness that forces on for one dispatch is never second-guessed by machine config.

This key is unrelated to the dispatch work gate (`DispatchAgentOpts.RequireToolUse`). Early-stop continuation is an engine-initiative nudge that still ships no continuation text of its own; the work gate acts only on an explicit per-dispatch declaration and supplies its own text. See [`docs/extensions/sdk-typescript.md`](../extensions/sdk-typescript.md#requiretooluse--declaring-that-a-dispatch-must-produce-work).

## steering

Controls how a **steer** — a new instruction aimed at a run that is already in flight — reaches that run. A steer comes either from an operator typing into a running turn or from a harness bubbling a completion, a poll result, or a check-in into it.

A steer can only enter the conversation at a turn boundary, because a provider request already in flight cannot have a message added to it. The engine buffers the steer, then injects it at the next drain checkpoint: the top of each agent-loop iteration, immediately after tool results are saved, and before an `end_turn` completes. Every buffered steer drains at the first checkpoint reached, in arrival order, so a corrected instruction still lands after the one it corrects.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `interruptStream` | bool (nullable) | `true` | When on, a steer that arrives while the model is streaming assistant text ends that provider call early so the steer applies on the very next turn. The partial assistant text is kept and persisted; the model sees its own partial output followed by the new instruction. Set to `false` to let every provider call finish as issued, accepting that the steer waits for the stream to end. |
| `bufferSize` | int | `32` | Per-run steer channel capacity — how many steers may be outstanding before the engine reports `channel_full` and refuses one. |

```json
{
  "steering": {
    "interruptStream": true,
    "bufferSize": 32
  }
}
```

**Why interruption defaults on.** Steering exists to change what an agent is doing now. An instruction that only applies after the current stream finishes is not steering the current turn — it is steering the next one, and in the meantime the agent keeps producing output for the instruction the operator just replaced. Because the engine keeps the partial output either way, the default costs nothing beyond a shorter assistant message.

Interruption never applies during tool execution. The provider protocol requires every `tool_use` block to be answered by a `tool_result`, so a tool call in flight must run to completion; the post-tool-results checkpoint is the earliest legal injection point there. A long tool call therefore still delays a steer, and that delay is a protocol constraint rather than a policy choice.

When the engine does interrupt a stream it emits `engine_steer_interrupted_stream`, carrying the number of assistant blocks preserved and the number of steers queued. That event reports the scheduling decision only; the steer's arrival in the conversation is still confirmed by `engine_steer_injected`. Consumers use the interrupt event to render a shortened assistant message as an intentional early stop rather than as a truncation or an error.

**Why the buffer is generous.** A rejected steer is the one outcome the engine cannot recover from — the caller has to decide what to do with an instruction the engine would not take. A queued message costs a pointer and a string; a dropped one costs a wrong-direction turn. Lower `bufferSize` only when you specifically want back-pressure at a low watermark.

## thinking

Engine-wide **default** for extended thinking (reasoning). Sets the baseline reasoning behavior for every run on the machine, so an operator can express "reason at medium by default" without every client having to ask for it on each prompt.

This block is the **weakest** of three resolution layers. Each stronger layer overrides it:

1. This block (`engine.json` — host-level default).
2. `EngineConfig.thinking` on [`start_session`](../protocol/client-commands.md#start_session) — a per-session default supplied by the client.
3. `thinkingEffort` on [`send_prompt`](../protocol/client-commands.md#send_prompt) — the per-prompt live control.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Whether runs carry a thinking directive by default. When false the engine emits none, which is the behavior when the block is omitted entirely. |
| `effort` | string | `""` | Cross-provider reasoning level, ascending: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. The forward-compatible control the provider landscape has converged on; the engine maps it to each provider's mechanism (Anthropic adaptive `effort`, OpenAI `reasoning_effort`, Gemini `thinkingConfig` budget). A level is only sent when the target model advertises it in `thinkingEfforts` — the engine defers to the model's declaration rather than hardcoding a ladder per model. |
| `budgetTokens` | int | `0` | Legacy explicit thinking-token budget, used only by models whose capability mode is `budget` and only when `effort` is empty. Prefer `effort`. |
| `streamDeltas` | bool (nullable) | `true` | Whether per-token `engine_thinking_delta` events reach the wire. Block-boundary events always emit, so turning this off keeps the liveness signal and the block summary. |
| `persist` | bool (nullable) | `true` | Whether reasoning **text** is retained in conversation history for later display. Never affects provider re-submission — reasoning is always stripped before being sent back to the model. |

```json
{
  "thinking": {
    "enabled": true,
    "effort": "medium"
  }
}
```

**Per-model capability still governs.** A model that declares no `thinkingMode` receives no thinking directive regardless of this block — the engine never forces reasoning onto a model that has not opted in. Declare `thinkingMode` and `thinkingEfforts` in [models.json](models.md#providersidmodelsname) to opt a model in.

**Turning thinking off for one conversation.** A client sends `thinkingEffort: "off"` on `send_prompt`. That is an explicit clear and it beats this default — the engine distinguishes the literal `"off"` (clear thinking for this run) from an absent field (no opinion, inherit the default). A client that omitted the field instead of sending `"off"` would silently inherit whatever is configured here.

**Cost note.** Reasoning tokens bill at output-token rates. Enabling a default here applies it to every run on the machine, including sub-agent dispatches, so the cost multiplies across a fan-out. This is why the engine ships with the block absent.

## workspaceWatchIgnore

Override the engine's default ignore-glob list for the `workspace_file_changed` hook's recursive filesystem watcher. The watcher is rooted at the session `workingDirectory` and fires the hook for every non-ignored create / modify / delete event under the tree. On Linux the ignore list runs before directories are attached, so ignored subtrees (e.g. `node_modules/**`) never consume inotify capacity in the first place. On macOS one FSEvents stream, and on Windows one handle on the root, covers the whole tree and the ignore list filters its events.

This is an array of doublestar glob patterns matched against repo-relative, forward-slash paths. The field is optional; omit it (or supply an empty array) to inherit the engine defaults below.

**Default ignore list (used when the field is unset or empty):**

```
.git/**
node_modules/**
dist/**
build/**
target/**
.next/**
.nuxt/**
.venv/**
__pycache__/**
.ion/**
.DS_Store
*.swp
*.swo
*.tmp
*~
```

**Replacement semantics, not merge.** When `workspaceWatchIgnore` is non-empty, the engine uses the supplied list **verbatim** and the defaults above no longer apply. If you want the defaults plus a few extra patterns, copy the default list into your config and append your additions. This was a deliberate choice: a merge mode would force a second "negate this default" syntax (e.g. `!node_modules/**`) that consumers would have to learn; full replacement keeps the contract one-liner.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspaceWatchIgnore` | string[] | engine built-in list (above) | Doublestar glob patterns matched against repo-relative paths. Non-empty array replaces the defaults; does not merge. |

```json
{
  "workspaceWatchIgnore": [
    ".git/**",
    "node_modules/**",
    "vendor/**",
    "**/*.generated.go"
  ]
}
```

Out-of-tree paths are deliberately out of scope. Extensions that need to watch files outside the working directory install their own `node:fs.watch` in their subprocess; the engine watcher exists to give every loaded extension a single coalesced view of in-tree changes without N extensions each spinning up their own watcher. See [`workspace_file_changed`](../hooks/reference.md#file-changes-2) in the Hook Reference for the hook payload and the rationale behind the engine-owned watcher.

## mcpServers

When enterprise policy names a managed engine file, servers a user adds are stored in `~/.ion/mcp/servers.json` in place of this file. See [User MCP servers](../enterprise/managed-config.md#user-mcp-servers).

Map of server name to MCP server configuration. Each entry defines a connection to a [Model Context Protocol](https://modelcontextprotocol.io/) server.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `type` | string | -- | Connection type. `"stdio"` for subprocess, `"sse"` for HTTP SSE. |
| `command` | string | `""` | Executable to run (stdio only). |
| `args` | string[] | `[]` | Arguments passed to the command (stdio only). |
| `url` | string | `""` | Server URL (SSE only). |
| `env` | object | `{}` | Environment variables passed to the subprocess (stdio only). |
| `headers` | object | `{}` | HTTP headers sent with SSE connections. |
| `oauth` | object | `null` | OAuth 2.0 configuration for authenticated MCP servers. |

### MCP OAuth fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `client_id` | string | -- | OAuth client ID. |
| `client_secret` | string | `""` | OAuth client secret (omit for public clients). |
| `auth_url` | string | -- | Authorization endpoint URL. Discovered when omitted. |
| `token_url` | string | -- | Token endpoint URL. Discovered when omitted. |
| `scope` | string | `""` | Space-separated scopes. |
| `redirect_uri` | string | `""` | Redirect URI for the OAuth flow. |
| `client_metadata_uri` | string | `""` | Client ID Metadata Document URL. |
| `resource` | string | `""` | RFC 8707 resource indicator. Discovered when omitted. |

Every login uses authorization code with PKCE. Full reference: [MCP Configuration](../mcp/configuration.md#oauth-fields).

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    },
    "remote-db": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer token-here"
      }
    }
  }
}
```

## permissions

Controls how the engine evaluates tool execution permissions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | -- | Default decision when no rule matches. `"allow"`, `"ask"`, or `"deny"`. |
| `rules` | array | `[]` | Ordered list of permission rules evaluated top to bottom. |
| `dangerousPatterns` | string[] | `[]` | Regex patterns for commands that should always require approval. |
| `readOnlyPaths` | string[] | `[]` | Path patterns where writes are denied. |

### Permission rule fields

| Field | Type | Description |
|-------|------|-------------|
| `tool` | string | Tool name to match (e.g., `"Bash"`, `"Write"`). |
| `decision` | string | `"allow"` or `"deny"`. |
| `commandPatterns` | string[] | Regex patterns matched against the command string (Bash tool). |
| `pathPatterns` | string[] | Glob patterns matched against file paths (Read, Write, Edit tools). |

Rules are evaluated in order. The first matching rule wins. If no rule matches, the `mode` default applies.

```json
{
  "permissions": {
    "mode": "ask",
    "rules": [
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git (status|log|diff)"]
      },
      {
        "tool": "Bash",
        "decision": "deny",
        "commandPatterns": ["rm -rf /"]
      },
      {
        "tool": "Write",
        "decision": "deny",
        "pathPatterns": ["/etc/**"]
      }
    ],
    "dangerousPatterns": ["curl.*\\| ?sh", "eval\\("],
    "readOnlyPaths": ["/usr/**", "/System/**"]
  }
}
```

## auth

Authentication and credential management.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `identityProvider` | string | `""` | Key in `oauth` used for operator or machine identity brokering. |
| `requireOperatorIdentity` | bool | `false` | Refuse session creation until the selected interactive OIDC provider has a usable operator grant. Invalid with `machineIdentity`. |
| `oauth` | object | `{}` | Map of provider ID to OAuth configuration. |
| `secureStore` | object | `null` | Credential storage backend configuration. |
| `cacheTtlMs` | int64 | `0` | How long to cache resolved credentials (milliseconds). |
| `refreshThresholdMs` | int64 | `0` | Refresh tokens this many milliseconds before expiry. |

## subscriptionLookup

Resolves a provider's subscription key from an endpoint you run, using the identity signed in through `auth.identityProvider`. One subscription is applied automatically, several are offered for a choice that is remembered, and none is reported as its own state. The key is cached per identity and outranks manual keys; a failed lookup leaves manual keys in use.

```json
{
  "subscriptionLookup": {
    "endpoint": "https://keys.example.org/subscriptions",
    "provider": "gateway",
    "scope": "api://keys/.default"
  }
}
```

Fields, behavior, and the published endpoint contract: [Subscription Lookup](subscription-lookup.md).

### Operator Context Identity migration

Interactive operator [Context Identity](../vocabulary/index.md#context-identity) requires `issuerUrl` on the selected `auth.oauth` provider. The engine verifies the identity token before it projects identity to an extension.

Stored grants without `identity_version: 1` are not Context Identity. After you add this configuration, restart or reload the engine and sign in once. That new sign-in creates a verified grant. Do not copy an old grant forward.

If identity is optional, a verification failure keeps unrelated sessions usable with Context Identity absent. `auth.requireOperatorIdentity` and an extension manifest requirement fail closed instead.

### OAuth provider fields

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string | OAuth client ID. |
| `clientIdEnv` | string | Environment variable holding the client ID, read when the provider is built (for example `AZURE_CLIENT_ID`, set by the AKS workload identity webhook). Mutually exclusive with `clientId`. An empty variable fails the provider. The variable is not removed. |
| `authorizationUrl` | string | Authorization endpoint. |
| `tokenUrl` | string | Token endpoint. |
| `scopes` | string[] | Requested scopes. |
| `usePkce` | bool | Enable PKCE. |
| `redirectUri` | string | Redirect URI. |
| `issuerUrl` | string | OIDC issuer used to discover endpoints. Required for interactive operator Context Identity. Explicit endpoint fields win. |
| `audience` | string | Default token audience/resource. |
| `audienceParameter` | string | `"audience"` (default) or RFC 8707 `"resource"`. |
| `machineIdentity` | object | Optional non-interactive identity source. Presence switches this selected provider from operator login to machine identity. See [Machine identity](../deployment/machine-identity.md). |

### Machine identity fields

| Field | Type | Description |
|---|---|---|
| `source` | string | `client_secret`, `certificate`, `federated_assertion`, `azure_managed_identity`, `gcp_managed_identity`, `aws`, or `credential_process`. |
| `clientSecretEnv` | string | Client-secret environment variable, captured and removed before subprocess launch. |
| `clientSecretFile` | string | Client-secret file path; mutually exclusive with `clientSecretEnv`. |
| `certificatePath` | string | PEM X.509 certificate path. May also contain its private key. |
| `certificateKeyPath` | string | Optional separate PEM private-key path. |
| `federatedTokenFile` | string | Rotating projected assertion path. |
| `azure.clientId` | string | Optional user-assigned Azure identity client ID. |
| `gcp.serviceAccount` | string | GCP attached service account; defaults to `default`. |
| `gcp.tokenType` | string | `access_token` (default) or `id_token`. |
| `aws.kind` | string | Explicit AWS source: `imds`, `ecs`, `eks`, `irsa`, or `env`. |
| `aws.roleArn` | string | IRSA role ARN; falls back to `AWS_ROLE_ARN`. |
| `aws.region` | string | STS/signing region. |
| `aws.stsEndpoint` | string | Optional STS endpoint override. |
| `credentialProcess.command` | string[] | Absolute executable path followed by arguments. No shell expansion. |
| `credentialProcess.timeoutMs` | int64 | Bounded helper deadline. |

Machine credentials stay engine-owned. OAuth access tokens and AWS temporary credentials are cached only in memory. Managed/federated sources persist no secret.

### Secure store fields

| Field | Type | Description |
|-------|------|-------------|
| `backend` | string | Storage backend: `"keychain"`, `"file"`, or others. |
| `serviceName` | string | Service name for keychain storage. |
| `filePath` | string | Path for file-based credential storage. |

## network

Network transport configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `proxy` | object | `null` | HTTP proxy settings. |
| `customCaCerts` | string[] | `[]` | Paths to PEM-encoded CA certificate files. |
| `rejectUnauthorized` | bool (nullable) | `null` | Set to `false` to disable TLS certificate validation. Use only for development. |

### Proxy fields

| Field | Type | Description |
|-------|------|-------------|
| `httpProxy` | string | HTTP proxy URL. |
| `httpsProxy` | string | HTTPS proxy URL. |
| `noProxy` | string | Comma-separated list of hosts that bypass the proxy. |

```json
{
  "network": {
    "proxy": {
      "httpsProxy": "http://proxy.corp.example.com:8080",
      "noProxy": "localhost,127.0.0.1,.internal.example.com"
    },
    "customCaCerts": ["/etc/ssl/certs/corp-ca.pem"]
  }
}
```

## logging

Local log file settings and operational-log egress. The full egress field list and its behavior
live in [Consuming logs](../observability/consuming-logs.md#option-3--programmable-egress-no-ion-provided-stack-required).
These fields decide how egress authenticates:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `egressTokenScope` | string | `""` | When set, every egress flush mints a fresh bearer token for this scope and sends it as `Authorization`, over any static header. |
| `egressTokenAudience` | string | `""` | Explicit audience/resource for the egress token. Empty uses the provider's default. |
| `egressTokenProvider` | string | `""` | Name of the `auth.oauth` entry that mints the egress token. Empty uses `auth.identityProvider`. Name a `machineIdentity` entry so a headless engine with no signed-in operator can authenticate. An `aws` machine identity cannot be used: it yields AWS credentials, not a bearer token. |

A headless engine shipping its logs under a client-secret machine identity:

```json
{
  "auth": {
    "oauth": {
      "log-shipper": {
        "clientId": "00000000-0000-0000-0000-000000000000",
        "tokenUrl": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token",
        "scopes": ["api://<ingest-app-id>/.default"],
        "machineIdentity": {
          "source": "client_secret",
          "clientSecretEnv": "ION_LOG_SHIPPER_CLIENT_SECRET"
        }
      }
    }
  },
  "logging": {
    "egressTargets": ["otel"],
    "egressOtel": { "enabled": true, "endpoint": "https://otel.example.com" },
    "egressTokenScope": "api://<ingest-app-id>/.default",
    "egressTokenProvider": "log-shipper"
  }
}
```

Enterprise config that seals egress on also seals `egressTokenScope`, `egressTokenAudience`, and
`egressTokenProvider` when it sets them.

`egressOtel.serviceName` names the OTLP exporter's instrumentation scope, not a service. Each shipped
record's service is its own resource `service.name` (`ion-<component>`), whichever process ships it.
See [Consuming logs](../observability/consuming-logs.md#otlp-is-the-canonical-egress).

## telemetry

Telemetry collection and export. The file target writes schema-v4 compact frames. This reduces repeated identity and correlation data; the telemetry forwarder expands both frame and expanded-event records for Alloy and other consumers, at any schema at or below its own.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Master switch for telemetry. |
| `targets` | string[] | `["file"]` when `enabled` and unset | Export targets: `"file"`, `"stdout"`, `"http"`, `"eventhub"`, `"otel"`. An explicit `[]` means no sinks. |
| `httpEndpoint` | string | `""` | HTTP endpoint for telemetry export. |
| `httpHeaders` | object | `{}` | Headers sent with HTTP telemetry requests. |
| `filePath` | string | `~/.ion/telemetry.jsonl` with the `file` target | Path for file-based telemetry output. The file uses v4 compact frames; consumers use the telemetry forwarder to expand them. |
| `privacyLevel` | string | `minimal` | Controls what data is collected: `minimal`, `standard`, or `full`. |
| `batchSize` | int | `0` | Buffered events that trigger an early flush. `0` means only the interval flushes. |
| `flushIntervalMs` | int64 | `5000` | How often to flush batched events (milliseconds). |
| `maxSizeMB` / `maxFiles` / `disableRotation` | int / int / bool | `20` / `3` / `false` | Rotation of the file target. |
| `httpRetryQueueMaxMB`, `eventHubRetryQueueMaxMB` | int | unbounded | Optional hard cap on the on-disk retry queue of the `http` / `eventhub` target. |
| `retryQueueSoftWarnMB` / `retryQueueStuckAfterMinutes` | int | `500` / `15` | Thresholds for the `engine_telemetry_health` signal. |
| `eventHubConnectionString`, `eventHubName`, `eventHubNamespace`, `eventHubTokenScope`, `eventHubTokenAudience` | string | `""` | Event Hub target and its authentication. |
| `eventHubMaxMessageBytes` | int | negotiated | Per-message size events are fitted to. |
| `oversizeEventPolicy` | string | `segment` | `segment` or `quarantine`, for an event larger than the transport allows. |
| `otel` | object | `null` | OpenTelemetry export configuration. |

The [Telemetry](../enterprise/telemetry.md) guide covers the Event Hub target, durable delivery, rotation, and the size contract in full.

### OpenTelemetry fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | Enable OTLP export. |
| `endpoint` | string | OTLP collector endpoint. |
| `protocol` | string | Export protocol (e.g., `"grpc"`, `"http/protobuf"`). |
| `headers` | object | Headers sent to the collector. |
| `serviceName` | string | Service name reported in traces and metrics. |
| `resourceAttributes` | object | Additional OTLP resource attributes. |
| `metrics` | object | OTLP metrics export of System Metrics. Off unless `metrics.enabled` is `true` and `telemetry.enabled` is `true`. Shares `protocol`, `headers`, `serviceName`, `resourceAttributes`, `tokenScope`, and `tokenProvider`. |
| `tokenScope` | string | When set, a fresh bearer token for this scope is minted before each trace and metrics export and sent as `Authorization`, over any static header. `metrics.tokenScope` wins for metrics. Empty sends only the static headers. |
| `tokenProvider` | string | Name of the `auth.oauth` entry that mints the `tokenScope` and `metrics.tokenScope` tokens. Empty uses `auth.identityProvider`, the behavior before the field existed. Name a `machineIdentity` entry so a headless engine with no signed-in operator can export; an entry also named by `logging.egressTokenProvider` is built once and shared. An unknown or interactive entry is logged as an error and falls back to `auth.identityProvider`. The engine logs `otlp export token provider installed` at start, and each exporter's start line carries `token_provider`. |

#### `otel.metrics` fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Export System Metrics as OTLP metrics. |
| `exportIntervalMs` | int | `60000` | How often metrics are exported. |
| `endpoint` | string | shared `endpoint` + `/v1/metrics` | A receiver that takes metrics at its own URL (Azure Monitor does). An endpoint with a path is used as given. |
| `temporality` | string | `cumulative` | `cumulative` or `delta`. Application Insights requires `delta`. |
| `tokenScope` | string | `otel.tokenScope` | When set, a fresh token for this scope is minted before each export and sent as `Authorization`, over any static header. Minted from `otel.tokenProvider`. |

The exported instruments are gauges `ion.host.cpu.utilization`, `ion.host.memory.available`, `ion.host.memory.limit`, `ion.host.disk.free`, `ion.process.cpu.utilization`, `ion.process.memory.rss`, `ion.engine.heap`, `ion.engine.goroutines`, `ion.engine.sessions`, and the counter `ion.system_metrics.samples`. The only attribute is `role` on the two `ion.process.*` instruments. See [Telemetry](../enterprise/telemetry.md#system-metrics) for sending them to Application Insights.

A headless engine exporting traces and System Metrics under the same machine identity its log egress uses:

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["otel"],
    "otel": {
      "enabled": true,
      "endpoint": "https://otel.example.com",
      "tokenScope": "api://<ingest-app-id>/.default",
      "tokenProvider": "log-shipper",
      "metrics": { "enabled": true }
    }
  }
}
```

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["http"],
    "httpEndpoint": "https://telemetry.example.com/v1/events",
    "httpHeaders": {
      "Authorization": "Bearer ingest-token"
    },
    "batchSize": 50,
    "flushIntervalMs": 10000
  }
}
```

## systemMetrics

The System Metrics sampler: host CPU, memory, load and disk, and CPU and memory for every process in the engine's own tree, labeled by role. It runs by default and keeps its numbers on the machine. They leave only through the outputs you turn on: the `system.metrics` telemetry event while `telemetry.enabled` is `true`, and OTLP metrics under `telemetry.otel.metrics`. See [System Metrics](../observability/README.md#signals-and-where-they-go).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool (nullable) | `null` (on) | `false` turns sampling off; `get_system_metrics` and `system_metrics_watch` are then refused. |
| `backgroundIntervalMs` | int | `30000` | Sampling interval while no connection watches. One sample per interval is logged at INFO. |
| `minIntervalMs` | int | `250` | The fastest interval a `system_metrics_watch` may ask for. |
| `diskPath` | string | `~/.ion` | Directory whose volume the disk figures report. |
| `telemetryIntervalMs` | int | `60000` | How often a `system.metrics` telemetry event is recorded while telemetry is enabled. |

An enterprise `systemMetrics` block replaces the user's whole block.

```json
{
  "systemMetrics": { "backgroundIntervalMs": 15000, "telemetryIntervalMs": 120000 }
}
```

## applicationConfig

The authenticated, deferred [Application Config](../vocabulary/index.md#application-config) source. The engine resolves it after a verified principal becomes available (an operator sign-in, a grant reconciled at startup, or a workload identity), never at process start. It GETs `endpoint` with that identity's bearer token and reads the response as an application config document (below). One fetch serves every extension; the result stays in memory and is never written to a configuration file. Sign-out or verification loss purges it. Omit the block and the subsystem is inert: extensions read `disabled` and nothing else changes.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `endpoint` | string | `""` | Absolute http(s) URL that answers with an application config document. |
| `refreshSeconds` | int | `900` | Refresh interval for the same identity. A failed first resolution retries on the same interval. Values below `30` are raised to `30`. |
| `scope` | string | `""` | Token scope to mint. Empty uses the identity's base grant. |
| `audience` | string | `""` | Token audience, for providers that bind a grant to a resource. |
| `timeoutMs` | int | `30000` | Bound on one fetch. |

A refresh moves the state to `refreshing` and keeps the previous values readable until the next document replaces them whole. Readers see the previous snapshot or the next one, never a mix. A refresh sends the last response's `ETag` as `If-None-Match` and its `Last-Modified` as `If-Modified-Since`; a `304 Not Modified` keeps the current document without downloading it again. A failed refresh keeps the previous snapshot. An enterprise `applicationConfig` block replaces the user's whole block. Requires `auth.identityProvider`.

```json
{
  "applicationConfig": {
    "endpoint": "https://config.example.invalid/v1/me",
    "refreshSeconds": 900,
    "scope": "api://config/.default"
  }
}
```

### Application config document

The endpoint answers with one document for the signed-in principal:

```json
{
  "common": {
    "values": { "region": "east" },
    "secrets": { "gatewayKey": "..." }
  },
  "extensions": {
    "storage-sync": { "values": { "storageEndpoint": "https://storage.example.invalid" } }
  }
}
```

| Field | Description |
|-------|-------------|
| `common` | The section every extension reads. |
| `extensions` | One section per extension, keyed by the extension's `id` in the enterprise [`extensionAllowlist`](../enterprise/sealed-config.md#extension-allowlist). |
| `<section>.values` | Plain configuration an extension may read. Any JSON values. |
| `<section>.secrets` | String secrets. The engine keeps them in memory and never returns them to extension code; an extension sees only their names. The engine uses them for [protected operations](#protectedoperations) and MCP [secret headers](../mcp/configuration.md#secret-headers) with `"secretSource": "applicationConfig"`. |

An extension sees `common` merged with its own section. Its own section wins when both name a key, and a key it declares as a secret replaces a common value of the same name. It never sees another extension's section. The key into `extensions` is the allowlist entry the extension passed at load, not the name the extension reports about itself. With no enterprise extension allowlist, every extension sees `common` only. A key may not be both a value and a secret in one section, and unknown top-level fields are rejected; either fails resolution.

## compaction

Context window compaction controls how the engine manages conversation length. The proactive limit reserves the active model's declared output capacity and summary headroom. API-backed conversations that resume at or above that limit are admitted so the run loop can compact them before the next provider request. The engine uses token-budget-based truncation with a four-tier summary fallback (session memory → LLM → extension hook → regex). See [Compaction](../sessions/compaction.md) for the full flow and rationale.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool (nullable) | `null` (enabled) | Global gate for proactive compaction. `false` disables proactive compaction; reactive compaction (triggered by provider `prompt_too_long` errors) still fires. |
| `strategy` | string | `""` | Strategy name for the strategy registry. Empty means auto-select from preferred order. |
| `keepTurns` | int | `2` | Minimum user turns to preserve during token-budget truncation (safety floor). |
| `threshold` | float | `0` | Legacy context utilization threshold (0.0–1.0). Superseded by the token-limit-based trigger but still honored when set. |
| `targetPercent` | float | `50.0` | Post-compact target. Auto/reactive passes apply it to the context window; explicit `/compact` applies it to the currently truncatable message estimate. |
| `microCompactKeep` | int | `3` | Number of recent user turns whose tool results are protected from micro-compaction. |
| `estimationPadding` | float | `1.33` | Conservative multiplier applied to heuristic token estimates to avoid immediate re-compaction. |
| `summaryEnabled` | bool (nullable) | `null` (enabled) | Whether LLM-based summarization is used during compaction (tier 2 of the four-tier fallback). |
| `summaryModel` | string | `""` | Model to use for LLM summarization. Empty uses the session's current model. |
| `summaryMaxTokens` | int | `0` | Max output tokens for LLM summarization. `0` uses the provider default. |
| `memoryEnabled` | bool (nullable) | `null` (enabled) | Whether the background session memory summarizer is active. When enabled, a `.memory.md` file is maintained alongside the conversation files and used as a zero-cost summary source during compaction. |
| `memoryModel` | string | `""` | Model to use for background memory summarization. Empty uses the session's current model. |
| `memoryUpdateThreshold` | int | `20000` | Token growth since last update before triggering a new background memory summary. |
| `memoryUpdateMinTurns` | int | `5` | Minimum turns between background memory updates. |
| `memoryMaxTokens` | int | `8192` | Max output tokens for the background memory summary. |

```json
{
  "compaction": {
    "enabled": true,
    "targetPercent": 50,
    "microCompactKeep": 3,
    "keepTurns": 2,
    "estimationPadding": 1.33,
    "summaryEnabled": true,
    "summaryModel": "",
    "memoryEnabled": true,
    "memoryUpdateThreshold": 20000,
    "memoryUpdateMinTurns": 5,
    "memoryMaxTokens": 8192
  }
}
```

## security

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `redactSecrets` | bool | `false` | When enabled, the engine scans tool output for secrets and redacts them before returning to the model. |
| `workspaceContainment` | bool | enabled when absent | Baseline worktree containment, checked in the tool loop: a conversation whose working directory is a registered worktree may not write into the base repository it was cut from or into a sibling worktree, and operations that would change which branch the worktree holds (or remove the checkout) are refused. Bench rules are client policy delivered through the tool gate, not part of this setting. Absent or `null` means enabled — this is a safety default, so only an explicit `false` disables it. |
| `principalPartitioning` | object | absent (disabled) | Per-principal conversation storage isolation (ADR-034). See below. |
| `sandbox` | object | absent (disabled) | User-layer OS sandbox policy (Seatbelt on macOS, bwrap on Linux) for shell execution. See below. |

### `security.principalPartitioning`

Isolates conversation storage per authenticated principal on a multi-tenant engine. See [ADR-034](../architecture/adr/034-principal-isolation-and-tenancy.md) and [Conversation storage](../architecture/conversation-storage.md#partition-layout) for the full directory layout.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Absent or `false` means every principal's conversations live in the historical flat `conversations/` directory — byte-identical to the pre-partitioning layout. `true` partitions each principal's conversations under `principals/<PrincipalDir(subject)>/conversations/`, a sibling of the flat root, which remains the home for unattributed sessions only. |
| `enforcement` | string | `"strict"` when `enabled: true` | `"strict"` — a session may only read or write its own partition; any cross-principal access is refused. `"read-only"` — cross-principal reads are allowed, writes remain confined to the session's own partition. `"none"` — partitioning is a storage-layout convention only; every session can read and write every partition. Logged at WARN on every boot, since this is never meant to be a silent downgrade. |

An enterprise sealed config can force this on and set a floor enforcement level via `security.principalPartitioning`'s equivalent enterprise fields (`requirePrincipalPartitioning`, `minEnforcement`) — see [Sealed configuration](../enterprise/sealed-config.md#security).

`get_host_info` publishes the resolved state as `principalPartitioning: {enabled, enforcement, root}` so a client or harness can detect the mode without inferring it from file layout. `start_session`'s result and the `identity_changed` hook payload (`ContextIdentity.storageRoot`) both carry the session's own resolved partition directory when partitioning is enabled and the session has a principal — see [Hooks reference](../hooks/reference.md#storageroot).

### `security.sandbox`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Enable the OS-level sandbox for shell execution. An enterprise sealed config can force this on (`security.sandbox.required`) regardless of this value. |
| `denyRead` | string[] | `[]` | Additional filesystem paths the sandbox denies read access to, beyond its built-in defaults. |
| `denyWrite` | string[] | `[]` | Additional filesystem paths the sandbox denies write access to. |
| `allowWrite` | string[] | `[]` | Filesystem paths explicitly allowed for write, carved out of an otherwise-denied region. |
| `network.allowedDomains` | string[] | absent | When set, network access from the sandbox is limited to these domains. |
| `network.blockedDomains` | string[] | absent | Domains the sandbox blocks even when otherwise allowed. |

When `security.principalPartitioning` is also active, the sandbox's filesystem rules are extended automatically: every other principal's partition directory (and the flat legacy root) is denied read, with an allow-read exception carved back for the session's own partition. This needs no separate configuration — it follows from `principalPartitioning` being enabled.

## git

Per-session git author identity, independent of the per-principal git *credential* resolution the server performs (see [Server configuration](server-json.md#git) and [Git identity setup](../deployment/git-identity-setup.md)) — this section resolves the name/email a commit records, not what it authenticates with.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `identity.fromPrincipal` | bool | `true` | When true, a session's git author/committer identity resolves from its `SessionPrincipal` (display name or username, paired with its email) whenever both are present. |
| `identity.required` | bool | `false` | When true, a Bash call that would record a commit (`commit`, `merge --no-ff`, `rebase`, `cherry-pick`, `am`, `tag`, `commit-tree`) is refused before it runs if no identity could be resolved, rather than stamping an unattributed commit. Read-only and non-authoring commands (status, diff, log, push, fetch, checkout, branch, stash, reset) are never gated. |
| `identity.machine` | `{name, email}` | absent | A fallback author identity used when `fromPrincipal` is false, or when a principal's name/email cannot be resolved. |

An enterprise sealed config can force `identity.required` on and/or replace `identity.machine` wholesale (`git.required`, `git.machine` under the sealed config's `git` block) — see [Sealed configuration](../enterprise/sealed-config.md#git).

## relay

WebSocket relay connection for mobile remote access.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | `""` | WebSocket relay URL (e.g., `wss://relay.example.com`). |
| `apiKey` | string | `""` | Bearer token for relay authentication. |
| `channelId` | string | `""` | 32-character hex channel identifier. |

## timeouts

Tune every internal timeout and retry limit. All duration fields are in milliseconds. Omit a field (or set to `0`) to use the compiled default. See [Limits](limits.md) for turn and budget limits; this section covers operational timeouts.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolDefaultMs` | int64 | `3600000` (60 min) | Per-tool execution timeout — a finite ceiling on a tool call (machine work), bounding a runaway tool that ignores cancellation. Applies to built-in, extension, and MCP tools unless a tool-specific timeout overrides it. While a tool is blocked on an elicitation (`ctx.elicit()`), this deadline is automatically suspended so the indefinite human-wait is not capped; it resumes for the remaining machine work. (Interactive permission prompts do not flow through this suspender — they are bounded by their own request context, not by `toolDefaultMs`.) |
| `toolStallMs` | int64 | `30000` (30 s) | Stall detection threshold. If a tool produces no output for this long, the engine logs a warning. |
| `commandStallMs` | int64 | `10000` (10 s) | Delay before the engine logs a command handler that has not returned. The log includes the command, request ID, session key, and duration. Positive values override the default; zero or a negative value uses the default. |
| `commandDispatchMs` | int64 | `25000` (25 s) | Deadline for an engine command result. On expiry, the engine returns the existing result envelope with `ok: false` and a timeout error. The handler remains in its command lane until it returns, so later work for the same session cannot overtake a late state change. Positive values override the default; zero or a negative value uses the default. |
| `bashDefaultMs` | int64 | `120000` (2 min) | Default timeout for `Bash` tool commands. Overridable per-call via the tool's `timeout` parameter. |
| `bashMaxMs` | int64 | `600000` (10 min) | Ceiling for the `Bash` tool's per-call `timeout` parameter. A larger requested value is clamped to this one and the clamp is reported on the tool result, so the model learns the real limit from the call it made. Set a **negative** value to disable the ceiling (`toolDefaultMs` still bounds the call). |
| `bashBlockingSleepMs` | int64 | `2000` (2 s) | Threshold at which a **leading** `sleep N` in a foreground `Bash` command is refused instead of executed. Only a bare integer sleep at the head of the command is inspected — `sleep 0.5`, `make && sleep 5`, and a sleep inside a loop, pipeline, or subshell all run normally, as does any sleep under `run_in_background`. The refusal names the background + notify path. Set a **negative** value to disable the gate. |
| `mcpCallMs` | int64 | `60000` (60 s) | MCP tool call timeout. How long the engine waits for an MCP server to return a tool result. |
| `mcpMetadataMs` | int64 | `30000` (30 s) | MCP metadata operation timeout (`initialize`, `listTools`, `listResources`, `readResource`). |
| `textGenMs` | int64 | `20000` (20 s) | Limit for one delegated-CLI text generation, the one-shot CLI call that produces a conversation title when the titling model has no API credential. Keep it below `commandDispatchMs`. |
| `mcpWriteMs` | int64 | `30000` (30 s) | Legacy MCP WebSocket write timeout. Retained for configuration compatibility; MCP WebSocket transport is no longer supported, so this setting has no effect. |
| `webFetchMs` | int64 | `30000` (30 s) | HTTP request timeout for the `WebFetch` tool. |
| `globMs` | int64 | `60000` (60 s) | Filesystem walk timeout for the `Glob` tool. |
| `sshDefaultMs` | int64 | `120000` (2 min) | Default timeout for SSH operations. |
| `extensionRpcMs` | int64 | `30000` (30 s) | How long the engine waits for an extension to respond to an RPC call (init, hook, tool, command). |
| `hookDefaultMs` | int64 | `30000` (30 s) | Default timeout for external hook execution. |
| `elicitationMs` | int64 | `0` (wait indefinitely) | Human-wait timeout. Governs **both** elicitation requests and permission dialogs — any point where the engine is blocked waiting for a person to answer. `0` or unset means **wait indefinitely** (the shipped default): a human who steps away must never have their elicitation silently cancelled or their permission silently denied by a wall-clock deadline. The wait is still released by session abort / teardown. Set a positive value for headless / no-human deployments that need a finite wait (e.g. `300000` to auto-resolve after 5 minutes). |
| `permissionTimeoutDecision` | string | `"deny"` | Fail-action applied to a **permission dialog** when a *finite* `elicitationMs` expires before the user answers. `"deny"` (default, fail closed) or `"allow"`. Only consulted when `elicitationMs` is positive; with the default indefinite wait the dialog never times out and this is never read. Elicitation requests have no allow/deny axis, so this does not affect them — an expired elicitation always returns cancelled. |
| `relayWriteMs` | int64 | `10000` (10 s) | Write timeout when forwarding messages to the relay server. |
| `broadcastWriteMs` | int64 | `5000` (5 s) | Write timeout for broadcasting events to connected socket clients. |
| `truncationRetries` | int | `3` | Maximum consecutive retries when the LLM response is truncated (hits `max_tokens`). |

These follow the same merge semantics as other config fields: higher-priority layers override lower ones. Zero means "use the compiled default."

```json
{
  "timeouts": {
    "toolDefaultMs": 300000,
    "mcpCallMs": 120000,
    "bashDefaultMs": 300000,
    "extensionRpcMs": 60000
  }
}
```

## workspace

Engine-wide limits for the filesystem-watch and session-lifecycle subsystems. Omit the block (or set a field to `0`) to use the compiled default. These protect the engine's kernel resources: on Linux each watched directory holds one inotify watch, and a leaked session keeps its watcher open.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionReapGraceMs` | int64 | `300000` (5 min) | How long a session whose last owning client connection has disconnected is kept alive before the engine reaps it (full teardown, releasing its workspace watcher). A client that reconnects and re-addresses the same session key within this window cancels the reap, so a transient socket flap or a desktop relaunch never tears down a live session. Raise it if your clients reconnect slowly; lower it to bound file-descriptor growth more aggressively. |
| `sessionIdleReleaseMs` | int64 | `1800000` (30 min) | How long a session must stay quiescent before the engine releases it with the same teardown as `stop_session`. Quiescent means no run, no accepted work pending, no agent in a non-terminal status, no live background process, and no extension schedule or webhook. The conversation is durable, so prompting the key again starts the session afresh. A negative value disables timed release. Extensions can keep a session through the `session_before_release` hook. See [Idle release](../sessions/lifecycle.md#idle-release). |
| `releaseIdleSessionOnAbort` | bool | enabled when absent | When an `abort` with scope `all` or `all_work` arrives for a session that was already quiescent, release the session instead of leaving it resident. Explicit `false` keeps the session. Independent of `sessionIdleReleaseMs`. |
| `maxWatchedDirs` | int | `50000` | Cap on the number of directories a single workspace watcher attaches to on Linux, where each one holds an inotify watch. When reached, the watcher keeps working for the directories it did attach and stops descending. Raise it for genuinely huge monorepos; lower it to keep a tighter bound per watcher. It does not apply on macOS or Windows, where one subscription on the root covers the whole tree. |
| `promptContext` | bool | enabled when absent | Workspace context in the prompt. The engine resolves context from three sources in precedence order: per-prompt `ClientWorkspaceContext` > session-level `EngineConfig.ClientWorkspaceContext` > engine worktree registry. Worktree facts (checkout, base repo, branch, siblings) come from the registry; bench and generic client data come from the client-supplied `ClientWorkspaceContext` (with structured bench facts in the `bench` field, generic data in `data`, and prose in `text`). Independent of `security.workspaceContainment` -- containment refuses writes regardless of whether the context prose is delivered. Extensions can replace or suppress the prose via `system_inject` with kind `workspace_context`. Explicit `false` disables. |

Same merge semantics as other config fields: higher-priority layers override lower ones. Zero means "use the compiled default."

```json
{
  "workspace": {
    "sessionReapGraceMs": 120000,
    "sessionIdleReleaseMs": 3600000,
    "maxWatchedDirs": 100000
  }
}
```

## wikiLinks

Controls [wiki-link maintenance](../architecture/wiki-links.md): rename detection in a watched workspace, rewriting `[[target]]` links when a document is renamed, and the read-only link integrity scan. Omit the block to use the defaults, which turn everything on.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `true` | Master switch. When `false` the engine records no file identity, detects no renames, rewrites nothing, and refuses the integrity scan without reading the workspace. A session with no extension loaded then runs no workspace watcher. |
| `propagateOnRename` | bool | `true` | Rewrite inbound links when a document is renamed. When `false`, renames are still detected and reported through the `workspace_file_renamed` hook, and no file is rewritten. |
| `integrityScan` | bool | `true` | Allow the on-demand link integrity scan. When `false` the scan is refused before the workspace is read. The scan never runs on its own. |
| `extensions` | string[] | `[".md"]` | File extensions treated as documents: the files scanned for links and the files whose renames are detected. Matched without regard to case. A missing leading dot is added. |

`propagateOnRename` and `integrityScan` are independent. Either can be turned off without the other. Both are off whenever `enabled` is `false`.

A later config layer overrides only the fields it sets. A non-empty `extensions` array replaces the earlier one.

```json
{
  "wikiLinks": {
    "enabled": true,
    "propagateOnRename": true,
    "integrityScan": false,
    "extensions": [".md", ".mdx"]
  }
}
```

Turning the block off does not change existing links. Turning it back on does not repair renames that happened while it was off. Run the integrity scan to find those.

## shell

Controls how the `Bash` tool selects the shell used to execute commands. Omit the block to inherit the default: a non-login, non-interactive shell that sources no rc files (`bash -c` on POSIX, PowerShell `-NoProfile -Command` on Windows). This is the historical behavior.

When `useLoginShell` is `true`, the engine runs each `Bash` command through the user's **login** shell (e.g. `zsh -lc`), so `.zprofile` is sourced for every command. This picks up the user's `PATH` and rc-exported environment that a non-login shell never sees — useful when the engine is launched from a GUI context (e.g. a macOS app bundle) that inherits a truncated `PATH`. Because each command re-sources the rc files, login-shell mode is robust to mid-session environment changes.

### Login and interactive shells read different files

This distinction is the usual reason a tool that works in your terminal is "not found" by the engine, so it is worth stating precisely:

| Shell mode | Flags | zsh sources | bash sources |
|---|---|---|---|
| Login, non-interactive | `-lc` | `.zprofile`, `.zlogin` | `.bash_profile` |
| Interactive login | `-ilc` | `.zprofile`, **`.zshrc`**, `.zlogin` | `.bash_profile`, **`.bashrc`** |

A typical developer machine splits `PATH` across both. `.zprofile` tends to hold what the system and package managers install (`/etc/paths.d` via `path_helper`, Homebrew); `.zshrc` tends to hold what per-tool installers append, because `nvm`, `bun`, `cargo`, and most `curl | sh` scripts write there by default. A login-only shell therefore sees a `PATH` that looks complete and is quietly missing those entries.

**`PATH` hydration always probes interactively first**, independent of `interactiveBash`. At startup the engine discovers the user's `PATH` and merges it into its own process environment, so every subprocess it spawns — extension hosts, `npm`, tool `child_process` calls — inherits the full set. Discovery wants the most complete answer available, so it tries an interactive login shell and falls back to a login-only one. The `interactiveBash` flag governs only how individual `Bash` commands are executed.

**POSIX only.** On Windows the PowerShell branch is unchanged; `useLoginShell` and `interactiveBash` have no effect there, as Windows has no analogous "login shell" concept.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `useLoginShell` | bool | `false` | When `true`, run `Bash` commands through the user's login shell (sourcing rc files) instead of the default non-login `bash -c`. POSIX only. |
| `shellPath` | string | `""` | Pins the shell binary to use when `useLoginShell` is `true`. Empty auto-resolves in order: `$SHELL`, else `/bin/zsh`, else `/bin/bash`. |
| `interactiveBash` | bool | `false` | When `true` (and `useLoginShell` is also `true`), run each `Bash` command through an **interactive** login shell (`-ilc`), which additionally sources `.zshrc` / `.bashrc`. Ignored when `useLoginShell` is `false`. |

### When to enable `interactiveBash`

You do **not** need it for `PATH` — startup hydration already handles that, and every `Bash` subprocess inherits the hydrated environment.

Enable it when a tool installs itself as a **shell function** rather than a binary, since a function only exists in a shell that sourced the rc file defining it. `nvm` is the canonical case: `nvm use` cannot work in a non-interactive shell at all.

The cost is real, which is why it is off by default. Interactive startup runs your full rc file for every command: prompt frameworks (`starship`), completion initialisation (`compinit`), and any rc-level diagnostics execute per call, adding latency (~130 ms on a warm macOS zsh) and potentially writing to stdout/stderr, where the output can contaminate tool results. If you enable it and see stray text in command output, an rc file is writing to a stream it should not — guard that line, or turn the flag back off.

```json
{
  "shell": {
    "useLoginShell": true,
    "shellPath": "/bin/zsh",
    "interactiveBash": true
  }
}
```

## featureFlags

Feature flag source configuration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `source` | string | `""` | Flag source type: `"static"`, `"file"`, or `"http"`. |
| `path` | string | `""` | File path (for `"file"` source). |
| `url` | string | `""` | HTTP endpoint (for `"http"` source). |
| `interval` | int64 | `0` | Poll interval in milliseconds (for `"http"` source). |
| `static` | object | `{}` | Static flag values (for `"static"` source). |

```json
{
  "featureFlags": {
    "source": "static",
    "static": {
      "new-compaction": true,
      "experimental-tools": false
    }
  }
}
```

## thinkingPolicy

Engine-wide operator policy for extended thinking (model reasoning). This is not
per-run thinking configuration, which consumers send on each prompt. This block
answers a question no per-run field can express: whether models may reason at
all on this install.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `disabled` | bool | `false` | Turns extended thinking off for the whole engine. Omitting the block, or leaving this `false`, permits thinking. |

Thinking is permitted out of the box. An engine with no `thinkingPolicy` block behaves
exactly as one that predates the field, so disabling is always an explicit act.

When `disabled` is `true`:

- No provider request carries a thinking directive, whatever a consumer sends as
  per-run thinking config. The operator switch outranks the caller.
- `list_models` reports every model with `supportsThinking: false`, no
  `thinkingMode`, and no `thinkingEfforts`. Clients render availability from the
  per-model capability they already read, so no client needs a new field to know
  reasoning is unavailable.

```json
{
  "thinkingPolicy": {
    "disabled": true
  }
}
```

Enterprise policy can seal this on via `enterprise.thinking.disabled`. The seal
is one way: an enterprise `disabled: true` cannot be re-enabled by a user or
project layer, while an enterprise block with `disabled: false` is a ceiling
rather than a mandate and leaves a locally-disabled install disabled.

## dispatchHistory

Bounds the record of ended dispatches each session keeps. When a dispatch ends, it leaves the live dispatch list and an entry with its final status, reason, completion time, and lineage is kept. Extensions read it with `ext/list_dispatch_history` (`ctx.listDispatchHistory()` in TypeScript, `ctx.ListDispatchHistory` in Go). This block keeps that record from growing without limit.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxEntries` | int | `200` | Most ended dispatches kept per session. The oldest completions are dropped first. `0` uses the default. A negative value turns the record off. |
| `maxAgeMs` | int | `3600000` | Drop an entry this many milliseconds after its dispatch ended. `0` uses the default. A negative value removes the age limit, leaving only `maxEntries`. |

A more specific config layer replaces the whole block. Each ended dispatch is also written to the session's conversation file, so a restarted session rebuilds its record within these same limits. A dispatch that was running when the engine process died comes back with status `lost`.

```json
{
  "dispatchHistory": {
    "maxEntries": 500,
    "maxAgeMs": 86400000
  }
}
```

## dispatchConversationRead

Bounds one page of a dispatch conversation read. An extension reads the conversation of a dispatch it owns with `ext/read_dispatch_conversation` (`ctx.readDispatchConversation()` in TypeScript, `ctx.ReadDispatchConversation` in Go). This block sets how much one call may return, so a large child transcript cannot fill the parent's context in one read.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultEntries` | int | `50` | Entries returned when the caller names no `limit`. |
| `maxEntries` | int | `200` | Most entries a caller may ask for. A larger `limit` is lowered to this. |
| `defaultBytes` | int | `32768` | Byte budget of a page when the caller names no `maxBytes`. |
| `maxBytes` | int | `262144` | Largest byte budget a caller may ask for. A larger `maxBytes` is lowered to this. |

`0` or a negative value uses the default for that field. A default above its maximum is lowered to the maximum. A more specific config layer replaces the whole block.

A single entry larger than the byte budget is returned alone with its text, tool output, and tool input cut to fit. Each cut block is marked `truncated` and carries its original size.

```json
{
  "dispatchConversationRead": {
    "defaultEntries": 20,
    "maxEntries": 100,
    "defaultBytes": 16384,
    "maxBytes": 131072
  }
}
```

## protectedOperations

Named outbound HTTP operations whose credential the engine injects at call time. An extension calls one by name with a payload (`ctx.protectedOperation` in TypeScript, `Context.ProtectedOperation` in Go). It never supplies the URL, the method, the injection slot, or the secret reference, so it never holds the secret and cannot send it anywhere else.

Only the global `~/.ion/engine.json` and enterprise config declare operations. A project `.ion/engine.json` block is ignored and logged (`project protected operations ignored`), because a checked-out repository must not decide where your secrets go. An enterprise operation replaces a user operation of the same name whole; user operations under other names remain. The engine reads the block fresh on every call, so adding or changing an operation needs no restart. With no block, every call fails with `protected operations are not configured`.

```json
{
  "protectedOperations": {
    "publish-metric": {
      "method": "POST",
      "url": "https://metrics.example.com/v1/metrics",
      "secretRef": "metrics-api-key",
      "injectAs": { "header": "X-Api-Key" },
      "bodySchema": {
        "type": "object",
        "required": ["value"],
        "properties": { "value": { "type": "number" } }
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `method` | string | required | HTTP method. |
| `url` | string | required | Absolute `http` or `https` destination. The path may hold `{name}` placeholders, filled from the payload. See below. |
| `secretRef` | string | required | Name of the secret: a credential-store entry, or an application config secret key. |
| `secretSource` | string | `"credentialStore"` | Where `secretRef` is read: `"credentialStore"` or `"applicationConfig"`. |
| `injectAs.header` | string | | Request header that carries the secret. Set exactly one of `header` or `query`. |
| `injectAs.query` | string | | Query parameter that carries the secret. |
| `injectAs.prefix` | string | `""` | Text placed before the secret, for example `"Bearer "`. |
| `bodySchema` | object | required | JSON Schema the payload must satisfy before the call is made. `{}` accepts any payload. |
| `headers` | object | omitted | Fixed headers sent on every call. The injected header wins over one with the same name. |
| `timeoutMs` | number | `30000` | Request deadline. |
| `maxBytes` | number | 5 MB | Response size cap. |
| `allowPrivateNetwork` | bool | `false` | Allows a private or reserved destination address. |

**Where the secret comes from.** The engine reads the secret on every call, so a rotated value is used on the next call with no extension change.

- `"credentialStore"` (the default) reads the engine's encrypted credential store, the store the `store_credential` command writes (`{"cmd":"store_credential","provider":"metrics-api-key","credential":"..."}`). A call made inside an attributed session reads that principal's own entry only. A call with no principal (a schedule or webhook) reads the shared entry.
- `"applicationConfig"` reads a key from the `secrets` of the [application config document](#application-config-document), held in memory only and never on disk. The calling extension's own section wins over `common`, exactly as its reads do, so an extension-owned secret is used only when that extension makes the call. A key that is a plain `values` entry is refused. Before sign-in, or while the document is still loading, the call fails with the state it is in.

**Path templates.** A `{name}` placeholder in the URL path is filled from the payload's top-level field `name`, so one operation covers `/v1/items/{id}`. The value must be a non-empty string or a number. It is URL-encoded, so a `/` stays inside its segment, and `.` or `..` is refused. Placeholders are only allowed in the path; one in the host, query, or fragment makes the declaration invalid. Give the schema a `required` entry for each placeholder.

**What the engine guarantees.**

- The payload is validated against `bodySchema` before any secret is read or any request is sent. A payload that fails is rejected.
- The payload is sent as the JSON body with `Content-Type: application/json` unless `headers` sets one. `GET` and `HEAD` send no body; their payload only fills the path. A missing or `null` payload sends no body, if the schema allows it.
- Redirects are never followed, so the injected secret cannot be carried to a second destination.
- The result is `{ status, headers, body }`. Every appearance of the secret in the response body or headers, raw or URL-encoded, is replaced with `[redacted]`.
- The secret never appears in a log line, an error message, or an event. Errors from the transport are redacted the same way.
- An unknown operation name is an error. There is no fallback to a caller-built request.
## Full example

A multi-provider configuration mixing a local Ollama model with a hosted OpenAI fallback. Pick whichever model fits the task and let the engine route to the right provider.

```json
{
  "backend": "api",
  "defaultModel": "qwen2.5:14b",
  "logLevel": "info",
  "providers": {
    "ollama": {},
    "openai": {
      "apiKey": "OPENAI_API_KEY"
    }
  },
  "limits": {
    "maxTurns": 100,
    "maxBudgetUsd": 25.0,
    "suppressSystemMessages": false,
    "disablePlanModeReminder": false,
    "disableTurnLimitWarning": false,
    "disableMaxTokenContinue": false
  },
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user"]
    }
  },
  "permissions": {
    "mode": "ask",
    "rules": [
      {
        "tool": "Bash",
        "decision": "allow",
        "commandPatterns": ["^git "]
      }
    ]
  },
  "security": {
    "redactSecrets": true
  },
  "timeouts": {
    "mcpCallMs": 120000,
    "extensionRpcMs": 60000
  },
  "telemetry": {
    "enabled": false
  }
}
```

## See also

* [models.json Reference](models.md) for registering custom models and tier aliases.
* [Provider Setup](../providers/index.md) for the catalog of supported providers and their environment variables.
* [ADR-034: Principal Isolation and Tenancy](../architecture/adr/034-principal-isolation-and-tenancy.md) for why `security.principalPartitioning`, `security.sandbox`, and `git.identity` exist.
* [Git identity setup](../deployment/git-identity-setup.md) for the operator-facing checklist behind `git.identity` and its server-side counterpart.

## newConversationDefaults

`newConversationDefaults` supplies defaults when a client creates a new Conversation. The engine resolves the block from global `~/.ion/engine.json`, then the project `.ion/engine.json` for the selected working directory. A project block replaces the global block. An enterprise block replaces both.

Use `profileName` for a portable profile reference. The project file contains a stable name. Each host maps that name to its local profile ID and extension paths from `~/.ion/settings.json`. `engineProfileId` remains supported for older managed config, but new project config should not use it.

| Field | Type | Description |
|-------|------|-------------|
| `baseDirectory` | string | Default working directory. Empty leaves directory selection to the client. |
| `profileName` | string | Portable local-profile name. Empty selects a plain Conversation when locked. |
| `profileLocked` | boolean | When true, `start_session` replaces the caller profile and extension list with the resolved profile. A missing named profile refuses the session. |
| `engineProfileId` | string | Compatibility profile reference for existing config. |
| `locked` | boolean | Compatibility lock field for existing enterprise config. |

```json
{
  "newConversationDefaults": {
    "profileName": "review",
    "profileLocked": true
  }
}
```

### Resolver command

`resolve_new_conversation_defaults` lets clients resolve the same policy before they create a session. Use `path` for one directory. Use `paths` for a batch. The batch response preserves request order.

```json
{"cmd":"resolve_new_conversation_defaults","path":"/work/repository","requestId":"one"}
{"cmd":"resolve_new_conversation_defaults","paths":["/work/one","/work/two"],"requestId":"batch"}
```

The single response data is one resolved record. The batch response data is `{ "defaults": [...] }`. Each resolved record contains `path`, `baseDirectory`, `profileName`, `profileId`, `extensions`, and `profileLocked` when set. Resolution does not create a session. `start_session` repeats lock enforcement as the authority boundary.
