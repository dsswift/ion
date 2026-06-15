# Desktop (Electron + React + Zustand)

> **Plan resolution rule (applies to all fix plans for this area):** documenting a defect is not a resolution. See root [`AGENTS.md`](../AGENTS.md) § "Aspirational comments" → "The rule applies to plans, not just code".

> **Role in the consumer landscape.** This application is **a reference implementation** of how to consume the Ion Engine — one careful interpretation, not the canonical consumer set. The engine's real consumers are external SDK users, custom harnesses, and third-party clients. The desktop demonstrates engine features at the highest quality bar so external developers can learn from it; it does not demonstrate every engine feature, nor should it. When the engine ships a hook, field, or event variant the desktop does not consume, that is the expected default. See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers".

## View readiness principle

Every view must be complete and correct the moment it renders. When a user navigates to a conversation, opens a panel, or switches tabs, every visible element (badge counts, list items, status indicators, metadata) must reflect the current truth immediately. No loading placeholders for data that the application already has. No counts that update after the user sees them. No lists that populate seconds after the panel opens.

If the data is available in the store, the view reads it synchronously. If the data requires a fetch, the fetch must complete before the view renders, or the view must show a loading state that is visually distinct from "zero items." A badge that shows "1" and then changes to "3" after a network round-trip is a bug, not a loading sequence.

This applies to every surface: tab status dots, attachment counts, notification badges, engine state indicators, resource lists, and permission queues. The snapshot is the mechanism that delivers truth from desktop to iOS. If a piece of information is visible in a view, it must be in the snapshot (or derivable from snapshot data) so iOS has it before the view renders.

## Commands

```bash
npm install         # runs claude-symlinks + electron-builder install-app-deps
npm run dev         # electron-vite dev (hot reload)
npm run build       # electron-vite build
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run doctor      # bash scripts/doctor.sh
```

Don't kill the user's running dev server. If a restart is needed, tell the user.

**Never run `make desktop`.** It replaces the running Ion.app binary and relaunches the engine, which kills any active Ion session, including the one you are running in. Conversation state is often lost. The user runs `make desktop` manually. If the packaged app needs rebuilding, tell the user.

## Layout

```
desktop/src/
  main/                    Electron main process
    index.ts               entry point (delegates to ipc/ handlers)
    ipc/                   per-feature IPC handlers
    remote/                relay/LAN transport, pairing, crypto
    cli-compat/            CLI tool compatibility shims
    utils/                 atomicWrite, secretStore
  preload/                 contextBridge IPC surface
  renderer/                React app
    App.tsx                root
    stores/sessionStore.ts thin orchestrator (109 lines); logic lives in stores/slices/
    stores/slices/         feature slices (engine, tabs, permissions, attachments, etc.)
    components/            UI (flat)
    hooks/                 React hooks
  shared/types.ts          cross-process types
```

## File-architecture rules

- 600-line cap per `.ts`/`.tsx`. CI hard-fails above.
- Co-locate tests as `Foo.test.tsx` next to `Foo.tsx`. Existing `__tests__/` migrates per phase.
- `TabStrip.tsx` and `GitPanel.tsx` are allowlisted god files. Do not extend; extract new modules.

## IPC

- All `ipcMain.handle/on` channels validated via `main/ipc-validation.ts` patterns. No exceptions.
- Channels namespaced by feature: `session:start`, `git:status`, `terminal:write`, etc.
- Renderer reaches IPC only through `preload/`. Renderer must not import from `main/`.
- Avoid `executeJavaScript` with string interpolation. Use preload-bridge functions.

## State

- Zustand. Single store (`sessionStore.ts`) composed from feature slices in `stores/slices/`.
- Cross-slice actions live at root; don't reach across slices.
- Per-conversation pane state lives in `conversationPanes: Map<tabId, ConversationPane>`. Each `ConversationPane.instances` entry is a `ConversationRef & ConversationInstance` — all per-conversation fields (messages, modelOverride, permissionMode, permissionDenied, conversationIds, draftInput, agentStates, statusFields) live directly on the instance, not in separate top-level Maps.
- User-state persistence (tabs, labels, settings) goes through `main/utils/atomicWrite.ts`. Never `writeFileSync` directly.

## Renderer conventions

- `useColors()` for all color references. Never hardcode color values (breaks theming).
- Phosphor icons (`@phosphor-icons/react`). Don't add other icon libraries.
- Use `<Tooltip text="...">` (from `components/git/Tooltip.tsx`) instead of the HTML `title` attribute. Native tooltips render behind the Electron overlay. The Tooltip component portals through PopoverLayer.
- Framer Motion for animations.
- Narrow Zustand selectors with custom equality functions; avoid whole-store subscriptions.

## PopoverLayer and pointer events

The `PopoverLayer` has `pointerEvents: 'none'` so it doesn't block interaction with the page beneath it. Any element portaled into it (context menus, dialogs, tooltips) must set `pointerEvents: 'auto'` on its outermost interactive container or clicks will silently pass through.

Context-menu components already do this on their `motion.div`. The `ConfirmDialog` component sets it on its backdrop. If you create a new overlay component that portals into `PopoverLayer`, add `pointerEvents: 'auto'` to its root — without it the component will render but be completely non-interactable with no visible error.

## Subprocess env

- `CLAUDECODE` and similar leakage env vars are stripped before spawn (`main/cli-env.ts`). Don't bypass.
- `node-pty` is legacy (still in dependencies for existing terminals). New subprocess work goes through `engine-bridge.ts` / `terminal-manager.ts` patterns.

## Hot reload

- Renderer changes hot-reload.
- Main-process changes require full restart of `npm run dev`. Tell the user — don't try to monkey-patch.

## Logging

- Use `main/logger.ts`. No `console.log` in shipped code.
- No silent `catch {}`. Either log at debug (intentional fallback), increment a counter (parse-loop tolerance), or escalate to `error`.

## Debugging the packaged app

**DevTools is not accessible in the packaged build.** `Cmd+Option+I` only opens DevTools in `npm run dev`. Never tell the user to open DevTools or read the renderer console in a `make desktop` build — the shortcut does nothing and there is no menu entry.

To diagnose renderer-side state in a packaged build, use one of these instead:

1. **Use `console.log` / `console.warn` / `console.error`.** All renderer console output is forwarded to `~/.ion/desktop.log` via the `console-message` handler in `window-manager.ts`. No allowlist — every log line is captured. Errors and warnings get distinct `[renderer:error]` and `[renderer:warn]` tags; everything else appears as `[renderer]`.
2. **Use `console.debug()` for high-frequency diagnostics** (e.g., per-frame or per-chunk). These are still forwarded (at verbose level) but signal intent — if log volume ever needs trimming, verbose-level lines are the first candidates for filtering.
3. **Inspect via the main-process snapshot.** `main/remote/snapshot.ts` polls renderer state through `executeJavaScript` and logs to `desktop.log`. Adding fields to that projection is the most reliable way to observe renderer store state from a packaged build.
4. **Build and run in dev mode** (`cd desktop && npm run dev`) if you genuinely need live DevTools. This is the only way to use them.

When investigating a renderer bug in a packaged build, **add the instrumentation first** (option 1, 2, or 3 above), ship a new build, then ask the user to reproduce. Asking the user to "check the console" is a wasted round-trip.

## Secrets

- Paired-device shared secrets and relay API key go through `safeStorage.encryptString` (OS keychain).
- Settings files use temp+fsync+rename. Reference: `engine/internal/conversation/filestore.go`.

## Cross-process types

- Live in `desktop/src/shared/types.ts`.
- Renderer must not import from `main/` (one type-only violation in `InputBar.tsx` for `DiscoveredCommand` — fix by lifting to `shared/types.ts`).

## Contract sync (cross-language types)

Shared types (`NormalizedEvent`, `StatusFields`, `EngineConfig`, etc.) are mirrored from Go. A contract test (`src/shared/__tests__/contract-sync.test.ts`) validates TS types against the Go-generated manifest (`engine/internal/types/testdata/contracts.json`).

**When you add/change a shared type in `types-engine.ts` or `types-events.ts`:**

1. Update the type definition.
2. Update the field map in `src/shared/__tests__/contract-sync.test.ts` (e.g. add the new field name to the `TS_NORMALIZED_EVENTS` or `TS_SHARED_TYPES` entry).
3. Run `npm test` — the contract sync test will fail if your map doesn't match the Go manifest.

If a Go struct gained a field you don't have, the test says `"Go-only: [fieldName]"`. If you have a field Go doesn't, it says `"TS-only: [fieldName]"`. Fields intentionally TS-only (like `StatusFields.backend`) are excluded from the map with a comment.

## Notifications panel

The TabStrip contains a bell icon for global notifications (workspace-scoped resources). The NotificationsPanel popover shows briefing resources sorted newest-first with read/unread tracking. When the user reads a briefing, the desktop sends a `mark_read` delta through the engine so iOS reflects the same state.

Session-scoped resources appear in the per-conversation attachments panel (ConversationAttachmentsSheet on iOS, equivalent on desktop).

## Done criteria

1. `npm run typecheck` passes.
2. `npm test` passes.
3. `make check-file-sizes` passes.
4. UI changes: smoke-tested in `npm run dev`. Report what was tested.
5. Don't `git push`.
6. **iOS parity check.** If the change affects a feature that exists on iOS (tab status, engine instances, permissions, working state), verify the iOS side is updated or document why it's deferred. See root `AGENTS.md` § "Cross-platform parity".
