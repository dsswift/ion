---
title: Backend Capability Matrix
description: What works on the ApiBackend vs each delegated-CLI backend (claude-code, codex, grok, cursor), which gaps are closeable, and which are gated by the CLI's own business rules.
sidebar_position: 3
---

# Backend Capability Matrix

The [ApiBackend](backends.md) is the reference: the engine owns the agent loop,
so **every** engine feature is available. The delegated-CLI backends
(`claude-code`, `codex`, `grok`, `cursor`) hand the agent loop to a vendor
subprocess, so a feature is available on a CLI backend only when the engine can
wire it *around* that subprocess — via the tool server, the permission
ask-bridge, native-session cursors, or transcript bridging. Everything else is
either **closeable** (the engine could wire it and should) or **gated** (the
CLI owns that phase of execution and Ion cannot intercept it without fighting
the vendor's internals).

This document is the authoritative parity reference. It is produced and kept
current by the `ion--analyze-api-vs-cli` command pair; when you change backend
wiring, update this matrix in the same PR.

> **The one structural fact that explains most gaps.** A CLI-routed run is
> dispatched through `HybridBackend.StartRun`, **not** `StartRunWithConfig`, so
> the entire `RunConfig` — hooks, permission engine, tool router, agent
> spawner, telemetry, compaction, early-stop — is **dropped**
> (`engine/internal/backend/hybrid_backend.go`). The ApiBackend consumes all of
> it. The CLI backends receive back only what the **session layer** re-wires
> for them explicitly (`engine/internal/session/prompt_cli_hooks.go`,
> `prompt_delegated_permissions.go`). Everything not re-wired silently no-ops.

## Legend

- **✅ full** — same behavior as the ApiBackend.
- **⚠️ partial** — works, but with a material limitation (noted).
- **🔒 gated** — bridged as far as the CLI's protocol allows; the CLI owns the
  decision and the engine is informed post-facto, or cannot be informed at all.
- **❌ none** — not wired; the feature silently does nothing on this backend.
- **n/a** — not applicable to this backend.

Closeability of each ❌/⚠️ gap is classified in the [Gap ledger](#gap-ledger)
below: **CLOSEABLE** (engine-side wiring, no fighting the CLI) or **GATED**
(fundamentally limited by the CLI's business rules).

## Context & continuity

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Context model | engine-owned | native-session | native-session | native-session | native-session | `capabilities.go`. Engine-owned = Ion feeds the full transcript; native-session = the CLI owns its context window. |
| Native resume | n/a | ✅ | ✅ | ✅ | ✅ | `--resume <uuid>` / `ThreadResume` / ACP `session/load`. Per-provider cursor persisted in the `.tree.jsonl` header. |
| Cross-provider handoff | ✅ | ✅ | ✅ | ✅ | ✅ | CLI turns are persisted into Ion's transcript at run exit, so a later turn on any provider bridges the full history. Fidelity is a text transcript, not structured turns — the declared ceiling. |
| Conversation ownership | Ion store | CLI + Ion mirror | CLI + Ion mirror | CLI + Ion mirror | CLI + Ion mirror | The CLI owns the authoritative session; Ion mirrors user + final-assistant text so the transcript is complete. |

## Tools & dispatch

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Built-in tools (Read/Write/Edit/Bash/Grep/Glob/Web…) | ✅ | ✅ | ✅ | ✅ | ✅ | Each CLI ships its own equivalents; the model always has a file/shell/search tool set. |
| Vendor's own MCP servers | ✅ | ✅ | ✅ | ✅ | ✅ | Each CLI loads MCP from **its own** config, independent of Ion. |
| **Ion extension tools** | ✅ | ✅ | ❌ | ✅ | ✅ | `wireToolServer` exposes extension tools to the subprocess over MCP: claude-code via `--mcp-config`, grok/cursor via ACP `session/new` mcpServers. **codex is excluded** — its shared app-server takes MCP only at process-spawn time, not per session (see ledger). |
| **`ion_agent` (subagent dispatch)** | ✅ | ✅ | ❌ | ✅ | ✅ | `wireAgentToolServer` registers `ion_agent` on claude-code and grok/cursor (not codex). The model-called `ion_agent` handler now routes through the **same depth-0 dispatch** as the API Agent tool (`buildRootAgentSpawner`): registry registration, `engine_agent_state` (appears in the panel), telemetry, and the child's own tools (next row). Foreground/synchronous, matching the tool's result contract. |
| **Dispatched child gets ion tools** (extension tools + `ion_agent` for grandchildren) | ✅ | ✅ | ❌ | ✅ | ✅ | A CLI-routed dispatched child drops its `RunConfig`, so it used to be tool-orphaned. `BuildDelegatedChildToolServer` now gives each CLI child a per-child tool server sourced from its `RunConfig` — extension tools via the child's `McpToolRouter`, `ion_agent` via its `AgentSpawner` (grandchildren at depth+1). codex excluded (same shared-app-server gate). |
| Background / suspend-revive dispatch | ✅ | ❌ | ❌ | ❌ | ❌ | A CLI tool call is synchronous request→response; the CLI's model cannot go idle mid-tool-call and be revived. |
| AskUserQuestion | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | The CLI's own elicitation is used; the engine's `ChildElicitFn` symmetrization is ApiBackend-only. |

## Permissions & governance

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Permission prompt to the user | ✅ | 🔒 | 🔒 | 🔒 | 🔒 | Bridged: claude-code via the permission hook server; codex/grok/cursor via `SetPermissionAskCallback`. The **CLI owns the decision**; the engine surfaces the prompt but does not gate execution. |
| `PermEngine` policy enforcement (allow/deny/patterns) | ✅ | 🔒 | 🔒 | 🔒 | 🔒 | The `RunConfig.PermEngine` is dropped; the CLI's own approval mode is authoritative. |
| `OnPermissionRequest/Denied/Classify` hooks | ✅ | ❌ | ❌ | ❌ | ❌ | The engine's runloop fires these; the CLI runloop does not. |
| Sandbox (`SandboxCfg`) / `SecurityConfig` | ✅ | ❌ | ❌ | ❌ | ❌ | The CLI applies its own sandbox flags; Ion's sandbox config is not threaded. |
| Enterprise model allow/deny at dispatch | ✅ | ✅ | ✅ | ✅ | ✅ | Enforced in the session layer before dispatch, so it applies to every backend. |

## Plan mode

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Plan mode runs at all | ✅ | ✅ | ✅ | 🔒 | ✅ | grok's ACP advertises **no** plan/architect mode → the dispatch capability gate declines with a typed `engine_capability_unsupported` (session stays alive). |
| Plan captured into Ion's plan file + proposal card | ✅ | ✅ | ✅ | n/a | ✅ | claude-code captures from the ExitPlanMode arg or a plans-file Write; codex/cursor from native plan items. |
| `OnPlanModeEnter/Exit/AutoExit/Prompt` hooks | ✅ | ❌ | ❌ | ❌ | ❌ | The CLI owns plan mode; there is no Ion hook point inside the subprocess. |
| Bash-allowlist / plan-file write gating | ✅ | 🔒 | 🔒 | n/a | 🔒 | The CLI's native plan mode enforces read-only; Ion's per-command allowlist is not applied inside the subprocess. |

## Compaction & memory

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Proactive / reactive compaction | ✅ | 🔒 | 🔒 | 🔒 | 🔒 | The CLI manages its own context window; Ion's token-budget compaction does not run. |
| `OnRequestCompactSummary` (harness summarizer) | ✅ | ❌ | ❌ | ❌ | ❌ | ApiBackend-only. |
| Session-memory zero-cost summary | ✅ | ❌ | ❌ | ❌ | ❌ | `GetSessionMemory`/`ResetMemoryTracking` are dropped with the RunConfig. |

## Streaming, steering & lifecycle hooks

| Capability | api | claude-code | codex | grok | cursor | Notes |
|---|---|---|---|---|---|---|
| Mid-turn steering | ✅ | ✅ | ✅ | ❌ | ❌ | claude-code via stdin stream-json; codex via `turn/steer`. **ACP has no steer channel** (`acp_backend.go WriteToStdin` is a no-op). |
| `OnToolCall/OnPerToolHook/OnTurnStart/OnTurnEnd/OnBeforeProviderRequest/OnSystemInject` hooks | ✅ | ❌ | ❌ | ❌ | ❌ | The CLI owns the loop; none of the per-turn hooks fire. |
| `OnBeforePrompt` (extension prompt rewrite) | ✅ | ✅ | ❌ | ❌ | ❌ | Bridged for claude-code via `fireBeforePromptCli` (`prompt_dispatch.go`); not yet generalized to codex/grok/cursor (CLOSEABLE — see ledger C5). |
| `OnInitialMessages` (plugin UserPromptSubmit inject) | ✅ | ❌ | ❌ | ❌ | ❌ | ApiBackend-only; the per-turn `<system-reminder>` prepend could be applied at CLI dispatch (CLOSEABLE — see ledger C6). |
| Early-stop / continuation (`OnBeforeEarlyStopDecision`, `EarlyStopContinue`) | ✅ | ❌ | ❌ | ❌ | ❌ | The CLI decides when to stop; Ion cannot inject a continuation between the CLI's turns. |
| Turn/token/cost telemetry spans | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | Ion emits a single run-level telemetry event at `task_complete` for every backend; the ApiBackend's finer per-call/per-tool spans are not produced by the CLI subprocess. |
| Model-fallback / capability-unsupported / plan events | ✅ | ✅ | ✅ | ✅ | ✅ | Typed engine events emitted uniformly from the session/backend layer. |

## Gap ledger

Each gap below is a cell where a CLI backend is not ✅. Priority is from the
harness author's perspective (how often it bites × how many backends it
affects).

### CLOSEABLE — engine-side wiring, no fighting the CLI

Extension tools + `ion_agent` on grok/cursor were previously CLOSEABLE and are
now **done**: `mcpCapableCli` generalizes `wireToolServer`/`wireAgentToolServer`
to the ACP backends via `session/new` mcpServers (`prompt_cli_hooks.go`). The
remaining closeable set:

| # | Gap | Affected | Priority | Status / Approach |
| ---|---|---|---|---|
| C2 | Model-called `ion_agent` was a bare shim (no panel, tool-orphaned child) | claude-code, grok, cursor | **high** | **DONE.** `buildAgentToolHandler` now routes through `buildRootAgentSpawner` — the same depth-0 dispatch as the API Agent tool — so the child registers in the dispatch registry, emits `engine_agent_state` (appears in the panel), gets its own tool server, and can dispatch grandchildren. (The dispatch is foreground/synchronous by the tool's result contract; that is inherent, not a gap.) |
| C3 | Tool-call / file-change observation hooks don't fire on CLI | all CLIs | medium | Bridge tool-result and file-mutation observations from the subprocess stream into `OnFileChanged` / an observe-only tool hook. Observation only — not interception. |
| C5 | `OnBeforePrompt` bridged only for claude-code | codex, grok, cursor | medium | Generalize `fireBeforePromptCli` (already wired for claude-code) to rewrite `opts.Prompt`/`AppendSystemPrompt` before dispatch on the other CLIs. |
| C6 | `OnInitialMessages` (plugin UserPromptSubmit) not applied on CLI | all CLIs | low | Prepend the per-turn `<system-reminder>` injection to the CLI prompt at dispatch, same shape as C5. |
| C4 | Permission *classification* not consulted on CLI | all CLIs | low | Offer the engine classifier over the existing ask-bridge so the CLI can tier a request before prompting. |

### GATED — the CLI owns this phase; do our best or declare the limit

| Gap | Affected | Why it's gated |
|---|---|---|
| Ion extension tools + `ion_agent` on codex | codex | The codex app-server is one shared, lazily-spawned process multiplexing all sessions, and accepts MCP servers only at process-spawn time (`-c mcp_servers.*` / `~/.codex/config.toml`), never per session. The engine's ToolServer socket is per-session, so injecting it would require per-session codex processes or a stable session-multiplexing socket — a larger refactor, not a wiring change. Gated until then. |
| `PermEngine` as the authoritative allow/deny gate | all CLIs | The CLI executes tools in its own runtime; Ion cannot block a call the subprocess runs internally. The ask-bridge (prompt the user) is the enforcement ceiling. |
| Plan mode on grok | grok | grok's ACP advertises no plan/architect mode. Declared unsupported via `engine_capability_unsupported`; the session stays usable so the user can switch models or disable plan mode. |
| `OnPlanMode*` hooks + per-command bash gating | all CLIs | Plan mode runs inside the CLI's own system; there is no Ion hook point or gate inside the subprocess. |
| Proactive/reactive compaction + compaction hooks + session memory | all CLIs | The CLI owns its context window and session store; Ion's token-budget compaction and memory fast-path have no insertion point. |
| Per-turn / per-tool telemetry spans | all CLIs | The turn loop runs inside the subprocess; only the run-level boundary is observable. |
| Early-stop mid-loop continuation | all CLIs | The CLI decides when to stop and cannot be made to resume between its own turns from outside. |
| Mid-turn steering on ACP | grok, cursor | The ACP protocol exposes no steer channel. |
| Background / suspend-revive dispatch | all CLIs | A CLI tool call is synchronous request→response; the model cannot go idle mid-call and be revived. Synchronous (blocking) dispatch is the ceiling. |

## The parity goal

The target is: **few or no CLOSEABLE gaps** — anything the engine can wire
around the subprocess, it should — leaving only the GATED set, which is the
honest, irreducible cost of delegating the agent loop to a vendor CLI. When a
new engine feature lands, it belongs in the CLOSEABLE column until wired to the
CLI backends, or explicitly justified into the GATED column here.
