---
title: engine.json Reference
description: Complete field reference for Ion Engine's engine.json configuration file.
sidebar_position: 2
---

# engine.json Reference

This document covers every field in `engine.json`, used at both the user level (`~/.ion/engine.json`) and the project level (`.ion/engine.json`).

## Required configuration

Ion ships with no default model. Before the engine can run a prompt, you must either set `defaultModel` in `engine.json` or pass `--model` on the command line. You also need credentials for the provider that model maps to (a `*_API_KEY` env var, an entry under `providers.<id>.apiKey`, or no key at all if the provider is local). See [models.json Reference](models.md) for registering custom models and tier aliases.

## Top-level fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backend` | string | `"api"` | Backend mode. `"api"` for direct API calls, `"cli"` for CLI proxy. |
| `defaultModel` | string | `""` | Model identifier used when no `--model` override is passed. Required. The engine errors out if neither this field nor `--model` is set. |
| `logLevel` | string | `""` | Log verbosity. One of `"debug"`, `"info"`, `"warn"`, `"error"`. Empty string uses the engine default. |

## providers

Map of provider name to credentials. Keys are provider identifiers (e.g., `"anthropic"`, `"openai"`, `"groq"`).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `apiKey` | string | `""` | API key. If the value is all uppercase letters and underscores (e.g., `"ANTHROPIC_API_KEY"`), the engine resolves it from the environment variable of that name. |
| `baseURL` | string | `""` | Custom API endpoint. Use this for proxies, gateways, or self-hosted providers. |
| `authHeader` | string | `""` | Custom authorization header name. Overrides the provider's default auth header. |
| `displayName` | string | `""` | Human-friendly name clients show for this provider (e.g. `"dci Marketing"` for the provider id `dci-marketing`). Surfaced on the `list_models` `ProviderEntry` wire shape. Empty ⇒ clients fall back to their own built-in name map, then to the capitalized id. |

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

The feature is **off by default**. The engine provides the mechanism (cumulative output-token tracking, `before_early_stop_decision` and `early_stop_continued` hooks, the re-run-turn machinery) but ships no opinion about whether to nudge or what text to nudge with. A harness consumer must opt in — either by setting `enabled: true` in this block, by passing `RunOptions.EarlyStopEnabled = &true` per dispatch, or by wiring a `before_early_stop_decision` handler that returns `ForceContinue: &true`. Whichever turns the feature on, the harness must also supply a `ContinueMessage` via the hook — without one, the engine logs the no-op and falls through to normal completion.

See [ADR-002: Engine vs Harness for Early-Stop Continuation](../architecture/adr/002-engine-vs-harness-early-stop.md) for the full rationale behind the default-off, harness-owned-policy design.

Three resolution layers, lowest priority first:

1. This block (`engine.json` — host-level configuration).
2. Per-run `RunOptions` (a harness dispatching a single run; see the [Hook Reference](../hooks/reference.md)).
3. The `before_early_stop_decision` hook (programmatic, context-aware policy and the prompt text).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool (nullable) | `false` | Global gate. Set to `true` to enable the feature for every run on this machine. A harness still must supply a `ContinueMessage` through `before_early_stop_decision` for any injection to happen. |
| `budget` | int | `8000` | Output-token target per run. A run that ends at less than `thresholdPct` of this budget triggers the hook. Tune per typical agent output size. |
| `thresholdPct` | int | `90` | Completion threshold (percent of `budget`). The engine stops calling the hook once cumulative output tokens reach this percent of the budget. |
| `maxContinuations` | int | `3` | Cap on the number of continuation nudges per run. Prevents pathological loops with very chatty models. |
| `diminishingDelta` | int | `500` | Per-continuation token delta below which the engine declares diminishing returns and stops nudging early (after at least 3 continuations). |

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

To **explicitly disable globally** (the default) — every `end_turn` immediately completes the run with no hook consultation:

```json
{
  "earlyStopContinue": {
    "enabled": false
  }
}
```

### Reference policy implementation

The Ion desktop client ships a reference `before_early_stop_decision` handler in `desktop/src/main/early-stop-policy.ts` that:

- Reads a user-facing `enableEarlyStopContinuation` setting (default `true`).
- Returns `ForceContinue: &true` plus a Claude-Code-style `ContinueMessage` ("Stopped at X% of token target …") when the setting is on.
- Returns `nil` (no opinion) when the setting is off or when the engine's tentative `WouldContinue` is already false.

Harness engineers running the engine outside the Ion desktop are encouraged to copy or adapt this implementation. The engine deliberately ships no prompt text so the harness owns the wording (and the user-facing toggle, if any) end-to-end.

**Sub-agents are off by default.** Runs dispatched through the Agent tool have `IsSubagent=true` and the engine skips the feature for them automatically — sub-agents are summoned with a tight remit and should not be poked to keep working. Harness extensions can still force-on per dispatch via `RunOptions.EarlyStopEnabled = &true`.

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

Override the engine's default ignore-glob list for the `workspace_file_changed` hook's recursive filesystem watcher. The watcher is rooted at the session `workingDirectory` and fires the hook for every non-ignored create / modify / delete event under the tree. The ignore list runs before fsnotify descriptors are attached, so ignored subtrees (e.g. `node_modules/**`) never consume inotify capacity in the first place.

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
| `auth_url` | string | -- | Authorization endpoint URL. |
| `token_url` | string | -- | Token endpoint URL. |
| `scope` | string | `""` | Space-separated scopes. |
| `redirect_uri` | string | `""` | Redirect URI for the OAuth flow. |
| `use_pkce` | bool | `false` | Enable PKCE (Proof Key for Code Exchange). |

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
| `oauth` | object | `{}` | Map of provider ID to OAuth configuration. |
| `secureStore` | object | `null` | Credential storage backend configuration. |
| `cacheTtlMs` | int64 | `0` | How long to cache resolved credentials (milliseconds). |
| `refreshThresholdMs` | int64 | `0` | Refresh tokens this many milliseconds before expiry. |

### OAuth provider fields

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string | OAuth client ID. |
| `authorizationUrl` | string | Authorization endpoint. |
| `tokenUrl` | string | Token endpoint. |
| `scopes` | string[] | Requested scopes. |
| `usePkce` | bool | Enable PKCE. |
| `redirectUri` | string | Redirect URI. |

| `issuerUrl` | string | OIDC issuer used to discover endpoints. Explicit endpoint fields win. |
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

## telemetry

Telemetry collection and export.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `false` | Master switch for telemetry. |
| `targets` | string[] | `[]` | Export targets: `"http"`, `"file"`, `"otel"`. |
| `httpEndpoint` | string | `""` | HTTP endpoint for telemetry export. |
| `httpHeaders` | object | `{}` | Headers sent with HTTP telemetry requests. |
| `filePath` | string | `""` | Path for file-based telemetry output. |
| `privacyLevel` | string | `""` | Controls what data is collected. |
| `batchSize` | int | `0` | Number of events per export batch. |
| `flushIntervalMs` | int64 | `0` | How often to flush batched events (milliseconds). |
| `otel` | object | `null` | OpenTelemetry export configuration. |

### OpenTelemetry fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | Enable OTLP export. |
| `endpoint` | string | OTLP collector endpoint. |
| `protocol` | string | Export protocol (e.g., `"grpc"`, `"http/protobuf"`). |
| `headers` | object | Headers sent to the collector. |
| `serviceName` | string | Service name reported in traces. |
| `resourceAttributes` | object | Additional OTLP resource attributes. |

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

## compaction

Context window compaction controls how the engine manages conversation length. The engine uses token-budget-based truncation with a four-tier summary fallback (session memory → LLM → extension hook → regex). See [Compaction](../sessions/compaction.md) for the full flow and rationale.

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
| `bashDefaultMs` | int64 | `120000` (2 min) | Default timeout for `Bash` tool commands. Overridable per-call via the tool's `timeout` parameter. |
| `bashMaxMs` | int64 | `600000` (10 min) | Ceiling for the `Bash` tool's per-call `timeout` parameter. A larger requested value is clamped to this one and the clamp is reported on the tool result, so the model learns the real limit from the call it made. Set a **negative** value to disable the ceiling (`toolDefaultMs` still bounds the call). |
| `bashBlockingSleepMs` | int64 | `2000` (2 s) | Threshold at which a **leading** `sleep N` in a foreground `Bash` command is refused instead of executed. Only a bare integer sleep at the head of the command is inspected — `sleep 0.5`, `make && sleep 5`, and a sleep inside a loop, pipeline, or subshell all run normally, as does any sleep under `run_in_background`. The refusal names the background + notify path. Set a **negative** value to disable the gate. |
| `mcpCallMs` | int64 | `60000` (60 s) | MCP tool call timeout. How long the engine waits for an MCP server to return a tool result. |
| `mcpMetadataMs` | int64 | `30000` (30 s) | MCP metadata operation timeout (`initialize`, `listTools`, `listResources`, `readResource`). |
| `mcpWriteMs` | int64 | `30000` (30 s) | MCP WebSocket write timeout. How long a write to an MCP server's WebSocket can block. |
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

Engine-wide limits for the filesystem-watch and session-lifecycle subsystems. Omit the block (or set a field to `0`) to use the compiled default. These protect the engine's process file-descriptor table: each watched directory consumes one descriptor, and a leaked session keeps its watcher's descriptors open.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sessionReapGraceMs` | int64 | `300000` (5 min) | How long a session whose last owning client connection has disconnected is kept alive before the engine reaps it (full teardown, releasing its workspace watcher). A client that reconnects and re-addresses the same session key within this window cancels the reap, so a transient socket flap or a desktop relaunch never tears down a live session. Raise it if your clients reconnect slowly; lower it to bound file-descriptor growth more aggressively. |
| `maxWatchedDirs` | int | `50000` | Cap on the number of directories a single workspace watcher attaches a descriptor to. When reached, the watcher keeps working for the directories it did attach and stops descending. Raise it for genuinely huge monorepos; lower it to keep a tighter bound on per-watcher descriptors. |
| `promptContext` | bool | enabled when absent | Workspace context in the prompt. The engine resolves context from three sources in precedence order: per-prompt `ClientWorkspaceContext` > session-level `EngineConfig.ClientWorkspaceContext` > engine worktree registry. Worktree facts (checkout, base repo, branch, siblings) come from the registry; bench and generic client data come from the client-supplied `ClientWorkspaceContext` (with structured bench facts in the `bench` field, generic data in `data`, and prose in `text`). Independent of `security.workspaceContainment` -- containment refuses writes regardless of whether the context prose is delivered. Extensions can replace or suppress the prose via `system_inject` with kind `workspace_context`. Explicit `false` disables. |

Same merge semantics as other config fields: higher-priority layers override lower ones. Zero means "use the compiled default."

```json
{
  "workspace": {
    "sessionReapGraceMs": 120000,
    "maxWatchedDirs": 100000
  }
}
```

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
