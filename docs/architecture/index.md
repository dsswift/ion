---
title: Architecture
description: System architecture overview for Ion Engine and its clients.
sidebar_position: 1
---

# Architecture

Ion is a headless agent runtime. The engine is the product; any program that speaks its wire protocol is a client. The reference client set, Ion Studio (a desktop app, a headless Studio server, an iOS companion, and a relay), is archived with its history at [dsswift/ion-studio](https://github.com/dsswift/ion-studio).

Naming is not free-form. Every shared concept in this document has one canonical term, and the [Ion Vocabulary](../vocabulary/index.md) is the authority for it.

## System overview

```
Client ──[Unix socket, NDJSON]──→ Engine (ion serve)
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

## Two-domain vocabulary model

Ion has two domains. Every feature, bug, or design decision belongs to exactly one. The canonical name for every shared concept lives in the [vocabulary registry](../vocabulary/index.md).

| Domain | Location | Language | What it does |
|--------|----------|----------|-------------|
| **engine** | `engine/` | Go | Hooks, events, tool execution, LLM streaming, extension host, socket protocol. Headless -- no UI concepts. |
| **harness-sdk** | `~/.ion/extensions/` | TypeScript, Go (or any) | Extension code built on the engine through the SDK. Registers hooks, tools, and commands. Decides policy. |

A client is whatever renders engine events: it connects over the socket, holds no engine internals, and lives outside this repository.

When you analyze a feature gap or a bug, label it with its domain: engine (Go changes in `engine/internal/`) or harness-sdk (extension code). When a harness gap is caused by a missing engine capability, note both.

## Core principle

**Engine executes, harness decides.**

The engine never blocks for user input. The engine never persists memory. The engine never decides policy. The engine provides hooks, events, and pluggable interfaces. The harness decides behavior.

The engine is also UI-agnostic. It emits typed data events over the socket. It has no concept of panels, dialogs, buttons, or layouts. Clients interpret events however they choose. Extensions communicate state through hook responses and the event stream, never through UI primitives.

## Component guides

| Component | Guide |
|-----------|-------|
| Engine internals | [engine.md](engine.md) |
| Canonical terms | [Ion Vocabulary](../vocabulary/index.md) |
| Versioned formats and protocols | [Format Versions](format-versions.md) |

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
| [ADR-008](adr/008-wire-event-naming-and-ownership.md) | Accepted | Wire events are prefixed by the contract owner: `engine_` for engine-emitted events; a client's own events use its own namespace. |
| [ADR-009](adr/009-unified-conversation-model.md) | Accepted | One conversation type, one creation entry point, flat per-tab layout. The extension list (possibly empty) is the only variable. |
| [ADR-010](adr/010-bare-session-key.md) | Accepted | The session key for conversations is the bare tabId. The compound tabId:instanceId key is retired for conversations; terminals retain it. |
| [ADR-011](adr/011-tab-split-migration.md) | Accepted | Legacy multiplexed conversation tabs are split into N standalone tabs on disk using a backup-migrate-verify-rollback pattern. No history is lost. |
| [ADR-012](adr/012-enterprise-new-tab-defaults.md) | Accepted | A sealed EnterpriseConfig.newConversationDefaults policy delivered via get_enterprise_policy RPC and resolved by each client at startup. |
| [ADR-013](adr/013-engine-dead-clean-cancel.md) | Accepted | A cooperative cancel is a clean, recoverable exit. engine_dead fires only on abnormal termination. |
| [ADR-014](adr/014-dispatch-conversation-identity.md) | Accepted | Every dispatch mints a fresh conversation by default; continuation is an explicit, dispatch-id-targeted act; the engine is opinionless about conversation relationships. |
| [ADR-015](adr/015-hierarchical-dispatch.md) | Accepted | Orchestrator dispatches department leads; leads dispatch their own specialists. Each tier distills context and surfaces only genuinely unanswerable questions upward. |
| [ADR-016](adr/016-agent-state-grouped-snapshot.md) | Accepted | Same-name engine dispatches group into one representative AgentStateUpdate row; per-dispatch identity is preserved in metadata.dispatches[]. |
| [ADR-017](adr/017-opinionless-tool-instructions.md) | Accepted | The engine ships input-shape and channel mechanics for tool instructions; style, depth, and workflow framing are consumer-owned. |
| [ADR-018](adr/018-cost-centralization.md) | Accepted | Per-run token costs aggregate in one place rather than being recomputed by each consumer. |
| [ADR-019](adr/019-logging-architecture-and-standards.md) | Accepted | Canonical JSONL across every surface; no interpolated messages, no console.* in shipped renderer code, no silent catches. |
| [ADR-020](adr/020-dashboards-as-code.md) | Accepted | Observability dashboards are versioned artifacts in the repo, not console-edited state. |
| [ADR-021](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/021-studio-shell-mirror-store.md) | Accepted | The Studio window runs the real session store in mirror mode; shared surfaces are one component, and every action is classified forwarded or mirror-local. |
| [ADR-022](adr/022-dashboard-time-window-policy.md) | Accepted | Dashboard panels declare their time window explicitly rather than inheriting an ambient default. |
| [ADR-023](adr/023-root-session-park-and-wake.md) | Accepted | Background bash completion is session-scoped outstanding work; the root parks at the turn boundary and is woken per completion. |
| [ADR-024](adr/024-integration-workspace.md) | Accepted | The integration bench is a pure function of (source tip, ordered pinned members). Integration is manual, staleness is advisory, and landing absorbs a member into the base. |
| [ADR-025](adr/025-client-tool-gate.md) | Accepted | A session's owning client can refuse tool calls and provide its own tools over the wire; the engine owns the blocking mechanism and no policy. |
| [ADR-027](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/027-contextual-per-pairing-authentication.md) | Accepted | Interactive OIDC is pairing-contextual and user-initiated; desktop displays last-reported mobile identity without treating it as authority. |
| [ADR-028](adr/028-interrupted-run-recovery.md) | Accepted | Durable engine journals resume configured interrupted runs without replaying client input. |
| [ADR-032](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/032-authenticated-client-data-access.md) | Accepted | Cached desktop data is visible only while a pairing retains authenticated authority; transport loss and explicit authorization failure are separate states. |
| [ADR-038](adr/038-mode-invariant-prompt-prefix.md) | Accepted | A run's tool list and system prompt do not depend on plan mode. Plan mode is delivered as notices in the conversation and enforced when a tool is called, so switching modes keeps the provider's prompt cache. |
| [ADR-030](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/030-embedded-browser-surface.md), [ADR-031](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/031-deep-link-surface.md), [ADR-033](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/033-ion-studio-server-and-environments.md), [ADR-035](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/035-one-wire.md), [ADR-036](https://github.com/dsswift/ion-studio/blob/main/docs/architecture/adr/036-thin-clients-render-the-server-transcript.md) | Archived | Ion Studio decisions. They live with the archived Studio repository; the numbers stay reserved here. |
| [ADR-039](adr/039-engine-scoped-extension-hosts.md) | Accepted | An extension may run one host owned by the engine process. Its schedules and webhooks fire into headless sessions the engine mints per fire under a configured run-as principal, so scheduled work no longer needs an open conversation. |
