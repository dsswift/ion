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
npm run lint        # ESLint — enforces react-hooks rules + no-console in renderer/
npm run doctor      # bash scripts/doctor.sh
```

Don't kill the user's running dev server. If a restart is needed, tell the user.

**Never run `make desktop`.** It replaces the running Ion.app binary and relaunches the desktop. The engine is a persistent launchd daemon (not a desktop subprocess), but on launch the desktop re-bootstraps it and force-restarts the daemon (`launchctl kickstart -k`) when the bundled engine binary or plist changed — so a `make desktop` that ships a new engine binary recycles the daemon and kills any active Ion session, including the one you are running in. Conversation state is often lost. The user runs `make desktop` manually. If the packaged app needs rebuilding, tell the user.

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
    stores/sessionStore.ts thin orchestrator; logic lives in stores/slices/
    stores/slices/         feature slices (engine, tabs, permissions, attachments, etc.)
    components/            UI (flat)
    hooks/                 React hooks
  shared/                  cross-process types (domain files; types.ts is a barrel re-export)
```

## File-architecture rules

- 600-line cap per `.ts`/`.tsx`. CI hard-fails above.
- Co-locate tests as `Foo.test.tsx` next to `Foo.tsx`. Existing `__tests__/` migrates per phase.
- Files exceeding the cap must be split; `.file-size-allowlist.yml` (repo root) is the source of truth for any temporarily-exempt files. Do not extend an allowlisted file; extract new modules.

## IPC

- All `ipcMain.handle/on` channels validated via `main/ipc-validation.ts` patterns. No exceptions.
- Channels namespaced by feature: `session:start`, `git:status`, `terminal:write`, etc.
- Renderer reaches IPC only through `preload/`. Renderer must not import IPC/Electron-bound code from `main/`. The one allowed exception is a small set of *pure* helpers that happen to live under `main/` and are imported by value for shared logic (`main/slash-parse` `parseSlash`, `main/tab-migration-split` `SPLIT_SCHEMA_VERSION`, `main/tab-migration-unify` `migrateTabToUnified`). These should migrate to `shared/` when next touched; do not add new renderer→`main/` imports beyond pure helpers.
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
- `node-pty` is legacy (still in dependencies for existing terminals). New subprocess work goes through `terminal-manager.ts` patterns. Note: `engine-bridge.ts` is **not** a subprocess spawner — the engine is a persistent launchd daemon and the bridge only *connects* to its socket (`~/.ion/engine.sock`); it never spawns the engine.

## Hot reload

- Renderer changes hot-reload.
- Main-process changes require full restart of `npm run dev`. Tell the user — don't try to monkey-patch.

## Logging

Logs write to `~/.ion/desktop.jsonl` in the canonical Ion JSONL schema (`component=desktop`). See root [`AGENTS.md`](../AGENTS.md) § "Logging policy" for file locations, `jq` recipes, and LogQL cheat-sheet.

- **Main process:** use `main/logger.ts` (`log`, `debug`, `warn`, `error`).
- **Renderer process:** use `renderer/rendererLogger.ts` (`rInfo`, `rDebug`, `rWarn`, `rError`, `rTrace`). Renderer code cannot import `main/logger.ts` (it is Electron-bound and requires Node.js APIs). `rendererLogger.ts` routes through the contextBridge to the main process and lands in `~/.ion/desktop.jsonl`.
- No `console.*` in shipped renderer code — `make check-logging` (ADR-019) enforces zero tolerance. Use `rendererLogger.ts` instead; its output is forwarded to `desktop.jsonl` identically.
- No silent failures. This is enforced structurally by ESLint (`no-floating-promises`, `no-misused-promises`, `no-empty`) and the `check-logging` SILENT-CATCH category — but the discipline comes first, the gates are the backstop. Concretely: no empty `catch {}`, no floating promise, no `async` function passed where a `() => void` is expected, no swallowed `.catch(() => {})`. Either log (at debug for an intentional fallback, warn/error when the failure matters), increment a counter (parse-loop tolerance), or `void` a genuine fire-and-forget. A genuinely-benign swallow carries a trailing `// silent-ok: <reason>`. Route through `main/logger` (main) or `renderer/rendererLogger` (renderer); never `console.*` in renderer.

## Debugging the packaged app

**DevTools is not accessible in the packaged build.** `Cmd+Option+I` only opens DevTools in `npm run dev`. Never tell the user to open DevTools or read the renderer console in a `make desktop` build — the shortcut does nothing and there is no menu entry.

To diagnose renderer-side state in a packaged build, use one of these instead:

1. **Use `renderer/rendererLogger.ts` (`rInfo`, `rWarn`, `rError`).** Output routes through the contextBridge and lands in `~/.ion/desktop.jsonl` via `window-manager.ts`. `rInfo` appears as `[renderer]`; `rWarn`/`rError` as `[renderer:warn]`/`[renderer:error]`. Unlike `console.*`, these calls conform to ADR-019 and can be left in shipped code.
2. **Use `rTrace` or `rDebug` for high-frequency diagnostics** (e.g., per-frame or per-chunk). These forward at verbose level and signal intent — if log volume needs trimming, verbose-level lines are the first candidates.
3. **Inspect via the main-process snapshot.** `main/remote/snapshot.ts` polls renderer state through `executeJavaScript` and logs to `desktop.jsonl`. Adding fields to that projection is the most reliable way to observe renderer store state from a packaged build.
4. **Build and run in dev mode** (`cd desktop && npm run dev`) if you genuinely need live DevTools. This is the only way to use them.

When investigating a renderer bug in a packaged build, **add the instrumentation first** (option 1, 2, or 3 above), ship a new build, then ask the user to reproduce. Asking the user to "check the console" is a wasted round-trip.

## Secrets

- Paired-device shared secrets and relay API key go through `safeStorage.encryptString` (OS keychain).
- Settings files use temp+fsync+rename. Reference: `engine/internal/conversation/persistence.go` (`writeFileSynced`).

## Cross-process types

- Organized into domain files under `desktop/src/shared/`: `types-session.ts` (tabs, messages, attachments, git), `types-events.ts` (CLI stream events, normalized events, content blocks), `types-engine.ts` (engine runtime types), `types-engine-event.ts` (the `EngineEvent` discriminated union), `types-persistence.ts` (on-disk shapes), `types-ipc.ts` (IPC channel name registry). `types.ts` is a barrel re-export for backward compatibility — new types belong in the appropriate domain file, not directly in `types.ts`.
- Renderer must not import IPC/Electron-bound code from `main/` (see the IPC section for the pure-helper exception and its migration intent).

## Wire naming and contract rules (ADR 008)

The desktop owns the desktop↔iOS wire. All `RemoteEvent` and `RemoteCommand` members carry the `desktop_` prefix. Any new member introduced to `src/main/remote/protocol.ts` must carry the `desktop_` prefix from its first commit. Cross-prefixed members (e.g. `engine_` on a `RemoteEvent`) are non-conforming.

The desktop↔iOS wire operates under a **lockstep model**: every wire change ships to all clients in one PR. This is not a scrutinized breaking-change contract — it is a parity obligation. When reviewing or implementing desktop↔iOS wire renames, do not treat them as published-contract breaks. The only required gate is parity: `protocol.ts`, `RemoteCommand.swift`, `NormalizedEvent.swift` TypeKey raw values, and any handler that switches on the string must all be updated in the same commit (or PR).

See root `AGENTS.md` § "Contract stability" and [docs/architecture/adr/008-wire-event-naming-and-ownership.md](../docs/architecture/adr/008-wire-event-naming-and-ownership.md).

## Contract sync (cross-language types)

Shared types (`NormalizedEvent`, `StatusFields`, `EngineConfig`, etc.) are mirrored from Go. A contract test (`src/shared/__tests__/contract-sync.test.ts`) validates TS types against the Go-generated manifest (`engine/internal/types/testdata/contracts.json`).

**When you add/change a shared type in `types-engine.ts`, `types-events.ts`, or `types-engine-event.ts`:**

1. Update the type definition.
2. Update the field map in `src/shared/__tests__/contract-sync.test.ts` (e.g. add the new field name to the `TS_NORMALIZED_EVENTS` or `TS_SHARED_TYPES` entry).
3. Run `npm test` — the contract sync test will fail if your map doesn't match the Go manifest.

If a Go struct gained a field you don't have, the test says `"Go-only: [fieldName]"`. If you have a field Go doesn't, it says `"TS-only: [fieldName]"`. Fields intentionally TS-only (like `StatusFields.backend`) are excluded from the map with a comment.

## Notifications panel

The TabStrip contains a bell icon for global notifications (workspace-scoped resources). The NotificationsPanel popover shows briefing resources sorted newest-first with read/unread tracking. When the user reads a briefing, the desktop sends a `mark_read` delta through the engine so iOS reflects the same state.

Session-scoped resources appear in the per-conversation attachments panel (ConversationAttachmentsSheet on iOS, equivalent on desktop).

## ATV shell rules (overlay ↔ ATV parity)

The ATV window (`src/renderer/atv/`) runs the session store in MIRROR mode — see [ADR-021](../docs/architecture/adr/021-atv-shell-mirror-store.md) and `src/renderer/atv/README.md`. The rules that bite:

- **New store action** → classify in `src/shared/atv-mirror-actions.ts` (FORWARDED vs MIRROR_LOCAL with justification) or `mirror-parity.test.ts` fails.
- **Multi-step business flow** (approve-plan, implement, anything that reads store state between mutations) → ONE store action classified FORWARDED, never a component handler chaining store calls. A component handler runs in whichever window hosts it; in the mirror that mixes forwarded and local calls and its decisions read stale mirror state (the "Implement and Unpin filed under Planning" bug). `implementPlan` in `stores/slices/implement-slice.ts` is the pattern.
- **New event push from main** → route through `broadcast()`; `make check-atv-parity` fails direct `webContents.send` outside the owner-only allowlist in `scripts/check-atv-parity.sh`.
- **New shared surface** → mount the overlay's component in the ATV (one component, one store); bespoke ATV widgets only for canvas-coupled surfaces.
- **New ATV setting** → `SETTINGS_DEFAULTS` + the `ATV_SETTING_KEYS` allowlist in `main/ipc/atv.ts` + `AtvSettings`; cross-window convergence rides `ion:settings-changed` from the settings funnel.

## Done criteria

While developing, run only the **scoped** gates — see root [`AGENTS.md`](../AGENTS.md) § "Quality gates (run while developing)". The full `npm test` suite and `npm audit` are heavy gates that run at PR time (CI is authoritative; `/create-pr` runs the Linux parity subset, which includes the full desktop test run, before pushing); do not run them mid-development.

1. `npm run typecheck` passes.
2. `npm run lint` passes with zero errors when touching renderer/ code. This enforces `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, `react/no-unstable-nested-components`, and `no-console` — the structural gate against React error #185.
3. `npm test -- <pattern>` passes for the area you touched. The full `npm test` run is a heavy gate — it runs at PR time (CI is authoritative; `/create-pr` runs it inside the Linux container before pushing); don't run it repeatedly while iterating.
4. `make check-file-sizes` passes.
5. UI changes: smoke-tested in `npm run dev`. Report what was tested.
6. Don't `git push`.
7. **iOS parity check.** If the change affects a feature that exists on iOS (tab status, engine instances, permissions, working state), verify the iOS side is updated or document why it's deferred. See root `AGENTS.md` § "Cross-platform parity".
