---
title: Desktop Architecture
description: Electron architecture for Ion Desktop. Main process, preload, renderer.
sidebar_position: 3
---

# Desktop Architecture

Ion Desktop is an Electron client. Its only window is **Studio** (`desktop/src/renderer/studio.html`, entry `desktop/src/renderer/studio/main.tsx`), created by `desktop/src/main/studio-window-manager.ts`.

The desktop does not own the session store. The Ion Studio Server (`server/`, the `@ion/server` package) owns `useSessionStore` (`server/src/store/sessionStore.ts`). One server plus one engine is an Environment ([ADR-033](adr/033-ion-studio-server-and-environments.md)). Studio is a client of every Environment in its catalog, including the local one. Canonical names for shared surfaces: [Ion Vocabulary](../vocabulary/index.md).

## Process model

```
Studio renderer (React + Zustand)
  useSessionStore, booted as a mirror (studio/state/secondary-store.ts)
  StudioHost seam (renderer/host/) -> window.ion (preload bridge)
        |
Electron main process
  connection broker (main/connections/broker.ts): one Studio wire
  socket per Environment, frames relayed unchanged
  LocalServerSupervisor (main/local-server.ts): spawns and respawns
  the local server
        |  Studio wire (studio_action / studio_event)
Ion Studio Server (server/dist/main.js, child process)
  useSessionStore (owner), EngineControlPlane, EngineBridge
        |
Engine daemon
```

## Main process

- **Local server.** `LocalServerSupervisor` (`desktop/src/main/local-server.ts`) spawns the bundled server (`server/dist/main.js`) as a child process and restarts it on a backoff ladder. The single instance lives in `local-server-instance.ts`; `app-lifecycle.ts` starts it.
- **Connection broker.** `desktop/src/main/connections/broker.ts` holds one `EnvironmentConnection` per Environment (local, TCP, or relay transport), runs the `studio_hello`/`studio_welcome` handshake, and relays frames without reading `studio_action` payloads.
- **In-process server modules.** Main imports some `@ion/server` modules directly (for example the settings store and engine bootstrap). Their log lines go to `desktop.jsonl` through `desktop/src/main/server-logger-adapter.ts`.
- **Window-bound features.** Browser views, Playwright automation, native dialogs, and shortcuts stay in main (`studio-browser-views.ts`, `studio-playwright/`, `ipc/`).
- **Broadcast.** Main-process event pushes go through `desktop/src/main/broadcast.ts`. `make check-server-parity` fails a direct `webContents.send`.

## Server side of a conversation

These live in the server, not the desktop:

- **`EngineControlPlane`** (`server/src/engine/engine-control-plane.ts`): tab registry, session lifecycle, prompt send, cancel, permission and dialog responses. The instance is `sessionPlane` in `server/src/state.ts`.
- **`EngineBridge`** (`server/src/engine/engine-bridge.ts`): the socket connection to the engine. It connects to the engine address and never spawns the engine.
- **Prompt pipeline** (`server/src/engine/prompt-pipeline.ts`): one decision tree for slash commands and prompts from every client.
- **Event wiring** (`server/src/engine/event-wiring-session-plane.ts`): applies each control-plane event to the owner store, then broadcasts it to Studio clients.

## Preload

`desktop/src/preload/index.ts` uses `contextBridge.exposeInMainWorld` to expose a typed `window.ion` API. It is the only channel between renderer and main. The renderer reaches it through the `StudioHost` seam (`desktop/src/renderer/host/StudioHost.ts`): `ElectronStudioHost` wraps `window.ion`, and `BrowserStudioHost` serves the browser build of Studio.

## Renderer

### State management

`useSessionStore` is composed from feature slices in `server/src/store/slices/`. Studio bundles the same store and boots it with `desktop/src/renderer/studio/state/secondary-store.ts`:

- The store is the union of every connected Environment. Each tab carries its `environmentId`.
- FORWARDED actions are swapped for a `studio_action` round trip to the server that owns the tab (`connection/tab-environment.ts`).
- MIRROR_LOCAL actions run in the window only.
- The classification tables live in `packages/shared/src/studio-wire/actions.ts`. A new store action must be classified there.

Per-conversation state lives on `conversationPanes`: each `ConversationPane` holds `instances`, and per-instance fields (messages, model override, permission mode, draft input, agent states) sit on those instances.

### Theme system

The theme registry and CSS sync are in `desktop/src/renderer/theme-tokens.ts`; palettes are in `desktop/src/renderer/theme/` and `server/src/renderer/theme/palette-dark.ts`. `useColors()` (`desktop/src/renderer/preferences.ts`) returns the active palette for the selected theme. `syncTokensToCss()` writes every token to a `--ion-*` CSS custom property.

### Key components

| Component | Where | Purpose |
|---|---|---|
| `InboxSidebar` | `renderer/studio/inbox/` | Every conversation across Environments, by project and bench |
| `ConversationView` | `renderer/components/` | Message timeline, markdown, tool call cards |
| `InputBar` | `renderer/components/` | Prompt input with attachments, voice, slash commands, model picker |
| `StudioSurface` | `renderer/studio/` | The right-hand Surface panel and its tabs |

### Performance patterns

- Narrow Zustand selectors with custom equality functions keep streaming from re-rendering unrelated components.
- `useEngineEvents` (`renderer/hooks/useEngineEvents.ts`) batches `text_chunk` events per animation frame, with a short timer fallback.

## Studio Surface

Surface tabs (`desktop/src/renderer/studio/surface/`) live in a window-local Zustand store (`useSurfaceStore`) outside `useSessionStore`.

- `studioSurface` persists one descriptor record per conversation, a source-project-scoped Scratch Document map, the global Diff/Plan/Visualizer pin set, and one workspace-scoped Notification tab.
- Opening a notification replaces that global tab's resource. It stays open across conversations until the user closes it.
- Normal file tabs stay conversation-scoped.
- An unsaved Scratch Document follows every conversation whose canonical editor directory resolves to the same source project, including its worktrees. Saving removes the document from that project record and opens a normal file tab only in the active conversation.
- Explorer, Git, browser, terminal, and file tabs never pin.
- The surface store selects the mirrored active conversation synchronously (`surface-conversation-sync.ts`).
- Panel width persists per conversation on `SurfaceConversationPersisted.width`, alongside `visible`. `studioLayout.surfaceWidth` remains only as the default for a conversation that has never been resized.
- One desktop preference (`studioSurfaceSwitchMode`) controls whether visibility and width both stay live across a tab switch or restore each conversation's own saved state.
- Shape, ordering, and persistence contracts are shared modules (`packages/shared/src/studio-surface-*.ts`). One parser is both the renderer restore and the server-side `studioSurface` validator (`server/src/persistence/studio-settings-keys.ts`).
- File tabs are descriptors. Their buffers stay in `fileEditorStates`.

## Workspace Search and Pane Find

[Workspace Search](../vocabulary/index.md#term-workspace-search) is the sidebar's Search view (`Mod+Shift+F`). It sends `fs.searchText` to the conversation's server, which searches the same roots the Explorer lists (`useWorkspaceRoots`). Inside a git checkout the server runs `git grep` over tracked and untracked-but-not-ignored files; elsewhere it walks the directory. Both paths run each line through the shared matcher in `packages/shared/src/text-search.ts`, so the highlighted ranges come from the function that decided the match. A result opens its file tab through `revealFileLine`, and the file tab selects the match once its buffer loads.

[Pane Find](../vocabulary/index.md#term-pane-find) (`Mod+F`, `Mod+G`, `Mod+Shift+G`) acts on the pane that holds focus (`studio/find/pane-find.ts`). A canvas code editor in edit mode claims find requests and uses CodeMirror's own search, because CodeMirror renders only the visible lines. Every other pane (conversation, markdown preview, plan, diff) is searched by `useDomFind`, which paints matches with the CSS Custom Highlight API and never rewrites the DOM React owns. An open find over the Diff tab loads every file's diff so nothing is missed.

## Studio Browser Surface

The [Studio Browser Surface](../vocabulary/index.md#term-studio-browser-surface) is a Studio-only surface tab. It keeps a browser document mounted for each conversation so its history and session state survive conversation switches. Browser descriptors persist the URL, content mode, and session mode. Preview documents use the network shield by default. The main process owns partition policy and browser automation. See [ADR-030](adr/030-embedded-browser-surface.md).

## Data flow: prompt to response

```
User submits in InputBar
  -> store action (FORWARDED) -> studio_action over the Studio wire
  -> server: useSessionStore action -> prompt pipeline
  -> EngineControlPlane -> EngineBridge -> engine socket
  -> engine streams events -> EngineControlPlane emits NormalizedEvent
  -> event-wiring-session-plane.ts: owner store handleNormalizedEvent()
     then broadcast('ion:normalized-event') -> studio_event
  -> Studio: useEngineEvents -> mirror store handleNormalizedEvent()
  -> React re-renders ConversationView
```

## Settings projection to iOS

A curated subset of settings is projectable to iOS so the user can change them from a phone. The server owns this. The allowlist data is in `server/src/projectable-settings-data.ts`; the runtime API (validators, schema, value projection) is in `server/src/projectable-settings.ts`.

**Wire shape.**

- `desktop_settings_snapshot` (event) carries the current values, the projection schema (type, group, label, description, default per key), and ordered group descriptors. Consumers replace their cached view; they never merge.
- `set_desktop_setting` (command) writes one setting. `server/src/remote/handlers/desktop-settings.ts` validates the key against the allowlist and the value against the declared type, then routes the write by the key's scope in `packages/shared/src/settings-registry.ts`. An Environment-scoped key needs the `admin` scope.

**One write path.** Studio saves through `settings.*` actions (`server/src/protocol/settings-actions.ts`). Both edit surfaces persist through `persistAndBroadcastSettings` (`server/src/settings-broadcast.ts`). It diffs the projectable keys and broadcasts a fresh snapshot only when one changed.

**Schema on the wire.** iOS does not hardcode the projection. A new projectable setting needs only an allowlist entry; iOS renders the row from the next snapshot. iOS puts unknown `group` values in a generic "Other" section (`ios/IonRemote/Models/ServerSettingsModel.swift`).

## Worktrees and integration benches

Each conversation can run in its own git worktree. An **integration bench** layers several worktrees onto the source branch so combinations can be tested before anything lands. Design: [ADR-024](adr/024-integration-workspace.md). Operator guide: [docs/design/worktree-workflow.md](../design/worktree-workflow.md). Guards and lifecycle: [Worktrees and Benches](worktrees-and-benches.md).

### Module map

| Concern | Location |
|---|---|
| Land and sync | `server/src/worktree/integrate.ts`, `server/src/worktree/sync.ts` |
| Retire and re-attach | `server/src/worktree/relocate.ts` |
| Discard appraisal and work preservation | `server/src/worktree/safety.ts` |
| Close decision (never destructive) | `packages/shared/src/worktree-close-decision.ts` |
| Base staleness | `server/src/worktree/base-staleness.ts` |
| Worktree inventory | `server/src/worktree/inventory.ts` |
| Worktree registry | `server/src/worktree/registry.ts` |
| Bench assembly | `server/src/integration/bench-assemble.ts` |
| Bench workspace ops (pins advance here) | `server/src/integration/bench-ops.ts` |
| Bench persistence | `server/src/integration/bench-store.ts` |
| Bench write guard (history writes refused) | `server/src/integration/bench-guard.ts` |
| Member contribution and tree hash | `server/src/integration/bench-snapshot.ts` |
| Studio wire | FORWARDED store actions over `studio_action` (`packages/shared/src/studio-wire/actions.ts`); worktree git verbs in `server/src/protocol/git-actions.ts` |
| iOS wire | `server/src/remote/protocol-worktree.ts`, `server/src/remote/handlers/worktree.ts` (store-backed verbs in `worktree-store-commands.ts`) |
| Store state | `server/src/store/slices/worktree-inventory-slice.ts`, `bench-slice.ts` |
| UI | `desktop/src/renderer/studio/inbox/`, `desktop/src/renderer/components/BenchBar.tsx`, `WorktreeRow.tsx`, `worktreeRowState.ts` |
| Join | `packages/shared/src/worktree-list.ts` (worktrees and memberships, one ordered list) |

### State flow

The server owns the workspace record (`integration-workspaces.json` in the server's data directory, keyed by `(repoPath, sourceBranch)`). It computes every derived fact: staleness, base drift, discard safety, conflict attribution. One projection feeds every client:

```
server workspace record
  ├─ broadcast() -> studio_event   -> Studio
  └─ desktop_worktree_state (wire) -> iOS
```

Clients never derive these values locally. That keeps the pin and staleness vocabulary identical across surfaces.

### Invariants worth knowing before changing this code

- **Land and retire is terminal.** A successful operation integrates the branch, then retires the worktree: it leaves every bench, and its checkout, branch, and registry record are removed. Other worktrees get the landed content through normal Sync, then an explicit pin Update or assembly.
- **Assembly merges pins, never tips**, and never advances a pin. Only `updateMember` and `updateAllStale` in `bench-ops.ts` advance one. Breaking this drags one member's half-finished work into another's assembly.
- **Never add `git clean -x`** to the assembly. Keeping ignored build output is what makes an assembly incremental.
- **Closing a conversation never removes a worktree.** `desktop/src/main/__tests__/worktree-close-no-destroy.test.ts` asserts no store slice in `server/src/store/slices/` calls `gitWorktreeRemove`.
- **A new history-writing git handler must call `benchGuard`.** Committing, pushing, or rewriting a branch inside a bench loses the work on the next assembly. Index and working-tree operations (stage, unstage, discard, apply) are not guarded, so diff review still works in a bench. `server/src/git/__tests__/bench-guard.test.ts` drives the real git handlers, so a handler that skips the guard fails there.
- **The server has one definition of bench containment.** `resolveBenchFor` in `bench-guard.ts` is it; `bench-ops.isBenchDirectory` delegates to it. It matches a bench root or a separator-prefixed descendant, never a bare string prefix. A sibling named `<bench>-other` is not a bench.
- **Serialization.** Land and assembly both run on the repository's mutation queue (`OperationQueue`, `server/src/git/operationQueue.ts`, owned by `server/src/git/repository.ts`). Operations in one repo never interleave; separate projects run in parallel.
