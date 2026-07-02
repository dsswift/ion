---
title: Architecture
description: System architecture overview for Ion Engine and its clients.
sidebar_position: 1
---

# Architecture

Ion is a headless agent runtime with client applications that connect to it. The engine is the product. Desktop, iOS, and Relay are reference clients and infrastructure.

## System overview

```
Desktop (Electron) ──[Unix socket, NDJSON]──→ Engine (ion serve)
                                                  │
iOS (SwiftUI) ──[WebSocket]──→ Relay ──[WS]──→ Engine
                                                  │
                                          ┌───────┴───────┐
                                          │               │
                                   ExtensionHost    ApiBackend
                                   (JSON-RPC 2.0)   (agent loop)
                                          │               │
                                          │         LlmProvider.Stream()
                                          │               │
                                          │         Tool execution
                                          │         (parallel, errgroup)
                                          │               │
                                   SessionManager ────────┘
                                   (lifecycle, events, routing)
```

## Three-layer terminology

Ion has three distinct layers. Every feature, bug, or design decision belongs to exactly one.

| Layer | Location | Language | What it does |
|-------|----------|----------|-------------|
| **Engine** | `engine/` | Go | Hooks, events, tool execution, LLM streaming, extension host, socket protocol. Headless -- no UI concepts. |
| **Harness** | `~/.ion/extensions/` | TypeScript (or any) | Extension code built on top of the engine via the SDK. Registers hooks, tools, commands. Manages agent state, spawns subprocesses. |
| **Client** | `desktop/`, `ios/` | TS, Swift | Connects to engine via socket. Renders UI from engine events. No engine internals. |

When analyzing a feature gap or bug, always label it as engine (Go changes in `engine/internal/`), harness (extension code), or client (renderer/main process). If a harness gap is caused by a missing engine capability, note both layers.

## Core principle

**Engine executes, harness decides.**

The engine never blocks for user input. The engine never persists memory. The engine never decides policy. The engine provides hooks, events, and pluggable interfaces. The harness decides behavior.

The engine is also UI-agnostic. It emits typed data events over the socket. It has no concept of panels, dialogs, buttons, or layouts. Clients interpret events however they choose. Extensions communicate state through hook responses and the event stream, never through UI primitives.

## Component guides

| Component | Guide |
|-----------|-------|
| Engine internals | [engine.md](engine.md) |
| Desktop (Electron) | [desktop.md](desktop.md) |
| Relay (WebSocket) | [relay.md](relay.md) |
| iOS (SwiftUI) | [ios.md](ios.md) |

## Architecture decisions

| ADR | Status | Summary |
|-----|--------|---------|
| [ADR-001](adr/001-engine-vs-harness.md) | Accepted | Engine provides mechanics (discovery, parsing, graph). Harness owns orchestration (routing, workflow, policy). |
| [ADR-002](adr/002-engine-vs-harness-early-stop.md) | Accepted | Engine provides the mechanism. Harness owns the policy and the prompt text for early-stop continuation. |
| [ADR-003](adr/003-state-events-vs-workflow-events.md) | Accepted | An event reports either a state transition or a workflow proposal. Never both. |
| [ADR-004](adr/004-enter-plan-mode-prose-in-harness.md) | Accepted | Engine ships the sentinel mechanism and a one-line fallback. The harness owns the policy prose that tells the model when to enter plan mode. |
| [ADR-005](adr/005-plan-mode-prose-symmetry.md) | Accepted | Engine adds negative-example callouts to both plan-mode prompts, extends the reminder gate to fire on mature-session turn-1 runs, and exposes PlanModeSparseReminder as a parallel override to PlanModePrompt. |
| [ADR-006](adr/006-deterministic-seams-and-probabilistic-judgment.md) | Accepted | Within an Ion harness, invariants belong in deterministic hook code; decisions that benefit from context belong in the LLM. |
| [ADR-007](adr/007-plan-mode-auto-exit.md) | Accepted | The engine deterministically synthesizes ExitPlanMode at end-of-turn when a plan-mode run terminates without the model invoking the sentinel tool. |
| [ADR-008](adr/008-wire-event-naming-and-ownership.md) | Accepted | Wire events are prefixed by the contract owner: `engine_` for engine-emitted events, desktop-owned events use their own namespace. |
| [ADR-009](adr/009-unified-conversation-model.md) | Accepted | One conversation type, one creation entry point, flat per-tab layout. The extension list (possibly empty) is the only variable. |
| [ADR-010](adr/010-bare-session-key.md) | Accepted | The session key for conversations is the bare tabId. The compound tabId:instanceId key is retired for conversations; terminals retain it. |
| [ADR-011](adr/011-tab-split-migration.md) | Accepted | Legacy multiplexed conversation tabs are split into N standalone tabs on disk using a backup-migrate-verify-rollback pattern. No history is lost. |
| [ADR-012](adr/012-enterprise-new-tab-defaults.md) | Accepted | A sealed EnterpriseConfig.newConversationDefaults policy delivered via get_enterprise_policy RPC and projected to clients via desktop_settings_snapshot. |
| [ADR-013](adr/013-engine-dead-clean-cancel.md) | Accepted | A cooperative cancel is a clean, recoverable exit. engine_dead fires only on abnormal termination. |
| [ADR-014](adr/014-dispatch-conversation-identity.md) | Accepted | Every dispatch mints a fresh conversation by default; continuation is an explicit, dispatch-id-targeted act; the engine is opinionless about conversation relationships. |
| [ADR-015](adr/015-hierarchical-dispatch.md) | Accepted | Orchestrator dispatches department leads; leads dispatch their own specialists. Each tier distills context and surfaces only genuinely unanswerable questions upward. |
| [ADR-016](adr/016-agent-state-grouped-snapshot.md) | Accepted | Same-name engine dispatches group into one representative AgentStateUpdate row; per-dispatch identity is preserved in metadata.dispatches[]. |
