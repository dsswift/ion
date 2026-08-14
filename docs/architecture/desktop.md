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

Single Zustand store (`stores/sessionStore.ts`) composed from feature slices in `stores/slices/`:

- Tab list with full `TabState` objects (messages, status, attachments, permissions)
- `conversationPanes: Map<tabId, ConversationPane>` — each entry holds `instances: Array<ConversationRef & ConversationInstance>`. All per-conversation state (messages, modelOverride, permissionMode, permissionDenied, conversationIds, draftInput, agentStates, statusFields) lives on the `ConversationInstance` fields, not in separate top-level Maps.
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

## Settings projection to iOS

The desktop owns user preferences (`~/.ion/settings.json`). A curated
subset of those preferences is projectable to iOS so the user can flip
behavior toggles from a phone without affecting other paired desktops.
The allowlist + per-key metadata lives in
`desktop/src/main/projectable-settings.ts` — the single source of truth
for which settings reach iOS and what they look like.

**Wire shape.** Two additive wire types:

- `desktop_settings_snapshot` (event) carries the current values map
  *plus the projection schema* (type, group, label, description,
  defaultValue per key) *plus ordered group descriptors*. Snapshot
  semantics — consumers REPLACE their cached view; never merge. Emitted
  on initial pairing and on every projectable-setting change.
- `set_desktop_setting` (command) writes one setting. The handler
  validates the key against the allowlist, validates the value type
  against the declared schema, persists via `writeSettings`, then
  broadcasts a fresh snapshot to every paired iOS instance (including
  the writer — every device sees a consistent view).

**Per-desktop scoping.** iOS shows projected settings for the
currently-connected desktop only. Switching transports clears the iOS
cache and the new desktop's initial snapshot repopulates it.

**Schema-on-the-wire.** iOS does not hardcode the projection. Adding a
new setting on the desktop is a one-line entry in
`PROJECTABLE_SETTINGS`; iOS auto-renders the new row on the next
snapshot. The iOS UI tolerates unknown `group` identifiers by falling
back to a generic "Other" section so older iOS builds remain
forward-compatible.

**Local-change broadcast.** When the user flips a setting on the
desktop UI (via `SAVE_SETTINGS` in `ipc/settings.ts`), the handler
diffs pre/post against the allowlist and broadcasts a fresh snapshot
when any projectable key changed. The diff keeps the wire quiet for
non-projectable saves (paths, fonts, model picks).

**Reference:** [ADR-001](adr/001-engine-vs-harness.md) applied to a
*client* boundary rather than the engine one — desktop owns the
mechanism (file, allowlist, validator, broadcast); iOS owns the UI
policy (which sections, what order, what affordance per type).

## Worktrees and integration workspaces

Parallel feature development: each conversation can run in its own git worktree,
and an **integration bench** layers several worktrees onto the feature branch so
combinations can be tested before anything lands. Design rationale and the
rejected alternatives are in
[ADR-024](adr/024-integration-workspace.md); the operator-facing guide is
[docs/design/worktree-workflow.md](../design/worktree-workflow.md).

### Module map

| Concern | Location |
|---|---|
| Land / sync preflight and primitives | `main/worktree/integrate.ts`, `main/worktree/sync.ts` |
| Retire / re-attach | `main/worktree/relocate.ts` |
| Discard appraisal + work preservation | `main/worktree/safety.ts` |
| Close decision (never destructive) | `shared/worktree-close-decision.ts` |
| Base staleness | `main/worktree/base-staleness.ts` |
| Worktree inventory + source-branch registry | `main/worktree/inventory.ts` |
| Bench assembly (the pure function) | `main/integration/bench-assemble.ts` |
| Bench workspace ops (pins advance here) | `main/integration/bench-ops.ts` |
| Bench persistence | `main/integration/bench-store.ts` |
| Bench write guard (history writes refused) | `main/integration/bench-guard.ts` |
| Member contribution + tree hash | `main/integration/bench-snapshot.ts` |
| IPC | `main/ipc/worktree-lifecycle.ts`, `main/ipc/bench.ts` |
| iOS wire | `main/remote/protocol-worktree.ts`, `main/remote/handlers/worktree.ts` |
| Renderer state | `renderer/stores/slices/worktree-inventory-slice.ts`, `bench-slice.ts` |
| UI | `renderer/components/WorktreeListSection.tsx`, `BenchBar.tsx`, `WorktreeRow.tsx`, `worktreeRowState.ts` |
| Join | `shared/worktree-list.ts` (worktrees × memberships, one ordered list) |

### State flow

The main process owns the workspace record
(`~/.ion/integration-workspaces.json`, keyed by `(repoPath, sourceBranch)`) and
computes every derived fact — staleness, base drift, discard safety, conflict
attribution. Three clients render that one projection:

```
main-process workspace record
  ├─ broadcast()                     → overlay renderer + ATV mirror
  └─ desktop_worktree_state (wire)   → iOS
```

Clients never derive these values locally. That is what keeps the pin and
staleness vocabulary identical across surfaces, and it is why the ATV dock
mounts the overlay's own components rather than bespoke widgets.

### Invariants worth knowing before changing this code

- **Landing is terminal.** `landedAt` is the stored, irreversible witness of a
  successful Land. Land immediately removes the member from every bench without
  rebuilding or advancing remaining pins; the sealed checkout is review-only
  until explicit Retire. Remaining worktrees receive landed content through
  normal Sync, then explicit pin Update/assembly.
- **Assembly merges pins, never tips**, and never advances a pin. Only
  `updateMember` / `updateAllStale` in `bench-ops.ts` advance one. Breaking this
  means an assembly for one member drags in another's half-finished work.
- **Never add `git clean -x`** to the assembly. Preserving ignored build output
  is what makes an assembly incremental instead of cold.
- **Closing a conversation never removes a worktree.** A structural test
  (`worktree-close-no-destroy.test.ts`) asserts no renderer slice calls
  `gitWorktreeRemove` at all.
- **A new history-writing git IPC handler must call `benchGuard`.** Committing,
  pushing, or rewriting a branch inside a bench loses the work on the next
  assembly. Index and working-tree channels (`stage`, `unstage`, `discard`,
  `apply`) are deliberately NOT guarded — blocking them would break diff review
  in the bench. `bench-guard.test.ts` drives the real handlers, so a handler that
  forgets the guard fails there rather than passing a helper-only test.
- **There is one definition of bench containment.** `bench-guard.resolveBenchFor`
  is it, and `bench-ops.isBenchDirectory` delegates to it. It matches a bench
  root or a separator-prefixed descendant, never a bare string prefix — a
  sibling named `<bench>-other` is not a bench.
- **Serialization**: land and assembly both run on the per-repo
  `OperationQueue` (`git/repository.ts`), so concurrent operations in one repo
  never interleave, while separate projects proceed in parallel.

