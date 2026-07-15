---
title: Run Backends
description: The engine's run-backend set — API and delegated-CLI backends, per-provider routing, CLI probes, and engine-driven login.
sidebar_position: 2
---

# Run Backends

A **run backend** executes one prompt: it takes a `RunOptions`, drives an LLM
turn, and emits a stream of `NormalizedEvent`s. The engine ships several
`RunBackend` implementations in `engine/internal/backend/`, plus a router that
picks one per run.

| Backend | Kind | How it runs a turn |
|---------|------|--------------------|
| `ApiBackend` | `api` | Native HTTP provider layer. The engine owns the agent loop and calls the provider API directly with a key. |
| `ClaudeCodeBackend` | `claude-code` | Spawns the Claude Code CLI (`claude -p --output-format stream-json`) and normalizes its stream. Uses the user's Claude subscription. |
| `CodexBackend` | `codex` | Delegates to a persistent `codex app-server` subprocess (JSON-RPC). Uses a ChatGPT subscription or an OpenAI API key. |
| `AcpBackend` (grok, cursor) | `grok`, `cursor` | Delegates to an Agent Client Protocol agent (`grok agent stdio`, `agent acp`). |
| `HybridBackend` | `hybrid` | Owns a lazily-constructed set of the above, keyed by kind, and routes each run. |

The delegated-CLI backends (`claude-code`, `codex`, `grok`, `cursor`) do not
reimplement the agent loop — the CLI is the agent. The engine spawns it,
translates its protocol into `NormalizedEvent`s, and bridges its tool-approval
requests into the engine permission flow. This is the opinionless-core
principle: the engine owns the mechanism (spawn, transport, translation,
approval routing) and lets each vendor's CLI own the opinion (which tools, which
models, how it authenticates).

> **Feature parity.** Because the CLI owns the agent loop, not every ApiBackend
> feature is available on every CLI backend. The authoritative, per-backend
> parity reference — including which gaps are closeable and which are gated by
> the CLI's own rules — is the [Backend Capability Matrix](backend-capability-matrix.md).

## Delegation, not reimplementation

The engine deliberately does **not** own OpenAI's ChatGPT protocol, xAI's, or
Cursor's. Those surfaces are private and unstable. Instead the engine speaks
each CLI's published local protocol over stdio and lets the CLI own auth, token
refresh, model discovery, and backend routing. This is why "Sign in with
OpenAI" is `codex login`, not an OAuth flow the engine implements: owning the
vendor's private surface would mean chasing its internal changes forever.

Shared transport lives in `internal/rpcstdio` — a symmetric JSON-RPC 2.0
endpoint over a stdio pair. `internal/codexrpc` and `internal/acp` are the typed
protocol clients layered on top; the backends translate their notifications into
engine events.

## Routing

`HybridBackend` resolves the run's model to a provider ID
(`providers.GetModelInfo(model).ProviderID`) and picks a backend kind:

1. If the operator pinned that provider to a kind (`providers.<id>.backend` in
   `engine.json`), use it.
2. Otherwise apply the **default rule**: `anthropic` → `claude-code`, every other
   provider (including unregistered models) → `api`.

Per-provider preferences (validated at config load — invalid values reset to the
default rule with an ERROR log):

| Provider | Allowed backends |
|----------|------------------|
| `anthropic` | `api`, `claude-code` |
| `openai` | `api`, `codex` |
| `xai` | `api`, `grok` |
| `cursor` | `cursor` |
| all others | `api` |

`HybridBackend.ResolveFor(model)` is the single routing entry point; the session
package's `resolvedBackend` helper delegates to it. Inner backends are built
lazily on first route, so a process that never routes to codex never spawns
`codex app-server`. A requested kind whose backend has not been built yet
degrades to the shared `api` inner via `effectiveKind` (logged), so routing never
spawns a duplicate stand-in. The decision is recorded per run in a routing table
so `Cancel` / `WriteToStdin` stay consistent even if the model catalog mutates.

The top-level `"backend"` values `"api"` and `"claude-code"` keep
all-runs-one-backend semantics; `"hybrid"` is the router. `"cli"` is a
permanently accepted legacy alias for `"claude-code"`, normalized at config load.

## CLI probes and provider status

`internal/cliprobe` interrogates each delegated CLI for install path, version,
auth state (account type, plan, email), and its advertised models, and caches
the result per kind in a `Registry`. `list_models` reads the cache only — the
hot path never spawns a CLI. The registry is refreshed asynchronously at startup,
on `refresh_models`, and after a login completes.

Two consequences flow to the wire (`ProviderEntry`):

- `backend` — the run backend currently selected for the provider.
- `cli` — a `ProviderCliStatus` with install/auth detail (installed, binaryPath,
  version, authenticated, authMethod, planType, email, label). Clients render it
  to guide install and sign-in.

CLI-backed providers get their model list from the CLI's own listing
(`providers.SetExternalModels`), and HTTP `/models` discovery is **skipped** for
them. This is the structural fix for the ChatGPT-token-as-API-key failure: a
ChatGPT credential can't call `api.openai.com/v1/models` (it 403s), so codex-mode
openai never issues that request — its models come from `codex model/list`.

## Engine-driven login

Login is engine-driven but never blocks the socket. The client sends
`provider_login`; the engine resolves the provider's CLI kind, drives the flow in
the background, and broadcasts `engine_provider_login` events (one per stage:
`started`, `await_browser`, `await_device_code`, `completed`, `failed`,
`cancelled`). The consumer opens the browser or shows the device code; the engine
opens nothing.

- **codex**: `account/login/start` returns a browser URL or a device code; the
  engine waits for the `account/login/completed` notification.
- **grok / cursor**: ACP `authenticate`; the CLI drives its own browser.

`provider_login_cancel` aborts the in-flight login (and sends `account/login/cancel`
for codex); `provider_logout` clears the codex credential. On completion the
engine re-probes so the provider flips to authed.

## Approvals

The delegated CLIs run their own tools and ask the engine to approve them. Codex
sends `item/*/requestApproval`; ACP sends `session/request_permission`. Both route
through `Manager.permissionAskClosure` — the same bridge the claude-code hook
server uses — so an approval from any delegated CLI surfaces as a single
`engine_permission_request` event and blocks on the user's decision. The seam is
the `backend.PermissionAskable` interface; the session installs the closure via
`wireDelegatedPermissions`.

## Event translation

Each delegated backend maps its protocol's stream onto the engine's normalized
events. The shapes differ but the target vocabulary is shared:

| Engine event | Codex source | ACP source |
|--------------|--------------|------------|
| `text_chunk` | `item/agentMessage/delta` | `agent_message_chunk` |
| `thinking_block_start`/`delta`/`end` | `item/reasoning/textDelta` + item lifecycle | `agent_thought_chunk` |
| `tool_call` / `tool_result` | `item/started` / `item/completed` (command, file, mcp, ...) | `tool_call` / `tool_call_update` |
| `usage` | `thread/tokenUsage/updated` | prompt-result usage |
| `task_complete` | `turn/completed` | `session/prompt` return (stopReason) |
| `error` | `error` notification | prompt error |

Subscription-metered runs report `CostUsd: 0` in `task_complete` (usage is still
reported); the backend reports the CLI's own session id (codex thread, ACP
session) as the exit's session id so the session layer can resume it.

See [Hybrid Backend](./hybrid-backend.md) for the routing table internals.
