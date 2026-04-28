---
title: Desktop Architecture
description: Electron architecture for Ion Desktop. Main process, preload, renderer.
sidebar_position: 3
---

# Desktop Architecture

Ion Desktop is an Electron app that provides a graphical interface for the Ion Engine. It connects to the engine daemon over Unix socket, parses NDJSON events, and renders conversations in a transparent, always-on-top overlay window.

## Process model

```
┌──────────────────────────────────────────────────────────────┐
│                     Renderer Process                         │
│  React 19 + Zustand 5 + Tailwind CSS 4 + Framer Motion      │
│                                                              │
│  ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌────────────┐  │
│  │ TabStrip  │ │Conversation  │ │ InputBar │ │ Marketplace│  │
│  │          │ │   View       │ │          │ │   Panel    │  │
│  └──────────┘ └──────────────┘ └──────────┘ └────────────┘  │
│                         │                                    │
│                    sessionStore (Zustand)                     │
│                         │                                    │
│              window.ion (preload bridge)                     │
├──────────────────────────────────────────────────────────────┤
│                     Preload Script                            │
│  Typed IPC bridge via contextBridge.exposeInMainWorld        │
├──────────────────────────────────────────────────────────────┤
│                     Main Process                             │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                   ControlPlane                        │    │
│  │  Tab registry, session lifecycle, queue management    │    │
│  │                                                       │    │
│  │  ┌─────────────┐  ┌──────────────────┐               │    │
│  │  │ RunManager   │  │ EventNormalizer  │               │    │
│  │  │ Manages      │  │ Raw events       │               │    │
│  │  │ engine       │──│ -> canonical     │               │    │
│  │  │ connections  │  │   events         │               │    │
│  │  └─────────────┘  └──────────────────┘               │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────┐  ┌────────────────────────────┐      │
│  │ PermissionServer   │  │ Marketplace Catalog        │      │
│  │ HTTP hooks on      │  │ GitHub raw fetch + cache   │      │
│  │ 127.0.0.1:19836    │  │ TTL: 5 minutes             │      │
│  └────────────────────┘  └────────────────────────────┘      │
└──────────────────────────────────────────────────────────────┘
         │
    Engine daemon
    (~/.ion/engine.sock)
```

## Main process

### ControlPlane

Single authority for all tab and session lifecycle.

- **Tab registry** -- maps tabId to session metadata, status, and process PID
- **State machine** -- each tab transitions through: `connecting -> idle -> running -> completed -> failed -> dead`
- **Request routing** -- maps requestIds to active RunManager instances
- **Queue and backpressure** -- max 32 pending requests; prompts queue behind running tasks
- **Health reconciliation** -- responds to renderer polls with tab status and process liveness
- **Session ID tracking** -- maps session IDs to tabs for permission routing

### RunManager

Manages connections to the engine for each prompt.

- Reads NDJSON from the engine socket line by line via StreamParser
- Passes raw events to EventNormalizer for canonicalization
- Maintains stderr ring buffer (100 lines) for error diagnostics
- Cleans up connections on cancel, tab close, or unexpected disconnect

### EventNormalizer

Maps raw engine events to canonical `NormalizedEvent` types:

| Raw Event | Normalized Event |
|-----------|-----------------|
| `system` (subtype: init) | `session_init` |
| `content_block_delta` (text) | `text_chunk` |
| `content_block_start` (tool_use) | `tool_call` |
| `content_block_delta` (input_json) | `tool_call_update` |
| `content_block_stop` | `tool_call_complete` |
| `assistant` | `task_update` |
| `result` | `task_complete` |
| `rate_limit_event` | `rate_limit` |

### PermissionServer

HTTP server that intercepts tool calls via PreToolUse hooks.

1. ControlPlane starts PermissionServer on `127.0.0.1:19836`
2. When the engine wants to use a tool, it calls the hook URL
3. PermissionServer emits a `permission-request` event to ControlPlane
4. ControlPlane routes it to the correct tab
5. Renderer shows a PermissionCard with Allow/Deny buttons
6. User decision flows back through IPC to the HTTP response
7. Engine proceeds or skips the tool based on the response

Security: per-launch app secret, per-run tokens, sensitive field masking, 5-minute auto-deny timeout.

## Preload

The preload script uses `contextBridge.exposeInMainWorld` to expose a typed `window.ion` API. This is the only communication surface between renderer and main process. All methods map to `ipcRenderer.invoke()` (request/response) or `ipcRenderer.send()` (fire-and-forget).

## Renderer

### State management

Single Zustand store (`stores/sessionStore.ts`) holds all application state:

- Tab list with full TabState objects (messages, status, attachments, permissions)
- Active tab selection
- Marketplace state (catalog, search, filter, install progress)
- UI state (expanded, marketplace open)

### Theme system

Dual color palette (dark + light) defined as JS objects. `useColors()` hook returns the active palette. All tokens sync to CSS custom properties via `syncTokensToCss()` so CSS can reference `var(--ion-*)`.

### Key components

| Component | Purpose |
|-----------|---------|
| TabStrip | Tab bar with new tab, history picker, settings popover |
| ConversationView | Scrollable message timeline, markdown rendering, tool call cards |
| InputBar | Prompt input with attachments, voice, slash commands, model picker |
| MarketplacePanel | Plugin browser with search, semantic filters, install flow |

### Performance patterns

- Narrow Zustand selectors with custom equality functions to prevent re-renders during streaming
- RAF-throttled mousemove handler for click-through detection
- Debounced marketplace search (200ms)
- Health reconciliation skips setState when no tabs changed

## Click-through window

The app uses `setIgnoreMouseEvents` with `{ forward: true }` for OS-level click-through on transparent regions. The renderer toggles this on `mousemove` by checking if the cursor is over a `[data-ion-ui]` element. All interactive UI must be descendants of a `data-ion-ui` container.

## Data flow: prompt to response

```
User types prompt
  -> InputBar calls window.ion.prompt(tabId, requestId, options)
  -> ipcRenderer.invoke('ion:prompt', ...)
  -> Main: ControlPlane.prompt()
  -> RunManager connects to engine socket
  -> Engine streams NDJSON events
  -> StreamParser emits lines
  -> EventNormalizer maps to NormalizedEvent
  -> ControlPlane broadcasts via IPC
  -> Renderer: useClaudeEvents hook receives events
  -> sessionStore.handleNormalizedEvent() updates messages
  -> React re-renders ConversationView
```
