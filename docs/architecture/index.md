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
