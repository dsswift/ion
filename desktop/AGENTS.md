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

## Ion Desktop is not a web application

Ion Desktop is a packaged Electron application. `npm run dev` starts Electron through
`electron-vite`; it does not expose a supported standalone Ion page at
`http://localhost:5173` or any other browser URL. Never use `browser_navigate`,
Playwright against a guessed localhost address, or a normal web browser as proof that the
Ion Desktop UI works.

For visible Desktop verification, use the real Electron window. A packaged build requires
operator visual confirmation when no Electron-control tool is available. Use logs,
snapshots, socket queries, and tests only as additional mechanical evidence — never as a
replacement for the required look at a visible feature.

The Studio Browser is content embedded *inside* Ion Studio. Its browser tools inspect the
page loaded in that embedded surface; they do not inspect or control the Ion Desktop
application UI.

**Never run `make desktop`.** It builds a local `.pkg`, asks the running desktop to drain active work, and opens macOS Installer. Installing and relaunching the new desktop can replace the bundled engine and restart the daemon, which ends the engine process hosting this conversation after its work drains. The user runs `make desktop` manually when ready. If a packaged build is needed, tell the user to run it.

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

- `useColors()` for all color references. Never hardcode color values (breaks theming) — `src/renderer/theme/hardcoded-colors-scan.test.ts` fails the build on untagged literals. Interactive states (hover/pressed/focus/selected/disabled), layering, and token workflow: see [docs/design/desktop-style-guide.md](../docs/design/desktop-style-guide.md).
- Phosphor icons (`@phosphor-icons/react`). Don't add other icon libraries.
- Use `<Tooltip text="...">` (from `components/git/Tooltip.tsx`) instead of the HTML `title` attribute. Native tooltips render behind the Electron overlay. The Tooltip component portals through PopoverLayer.
- Framer Motion for animations.
- Narrow Zustand selectors with custom equality functions; avoid whole-store subscriptions.

## PopoverLayer and pointer events

The `PopoverLayer` has `pointerEvents: 'none'` so it doesn't block interaction with the page beneath it. Any element portaled into it (context menus, dialogs, tooltips) must set `pointerEvents: 'auto'` on its outermost interactive container or clicks will silently pass through.

Context-menu components already do this on their `motion.div`. The `ConfirmDialog` component sets it on its backdrop. If you create a new overlay component that portals into `PopoverLayer`, add `pointerEvents: 'auto'` to its root — without it the component will render but be completely non-interactable with no visible error.

## Popover positioning

A `position: 'fixed'` element is placed in viewport coordinates, so nothing in the layout stops it rendering past the window edge. Every popover, dropdown, context menu, tooltip, and picker must land fully inside the window. Which primitive you use depends on how the element is anchored.

| Anchor kind | Primitive | Examples |
|---|---|---|
| **A point** — a click coordinate, or "below this trigger". Anything with an `anchor: { x, y }` prop. | `useAnchoredPopover` (`hooks/useAnchoredPopover.ts`) | context menus, tab-group pickers, the worktree row menu |
| **An edge** — `bottom:` / `right:` computed from a trigger rect so the popover grows upward or leftward out of the input pill | `useViewportClamp` (`hooks/useViewportClamp.ts`) | status-bar pickers, the slash-command menu, hover cards |

`useAnchoredPopover` measures the rendered element in a layout effect and flips or clamps it *before paint*, so there is no visible jump. Gate the element on `visibility: pos.ready ? 'visible' : 'hidden'` and pass **everything that changes the rendered height** in `deps` (an inline rename panel, a state-gated verb list, an open submenu) — otherwise it stays placed for its first measurement and re-overflows when the content grows.

`useViewportClamp` corrects after layout via the CSS `translate` property, which composes with (never fights) Framer Motion's `transform` and any `translateX(-50%)` centring. It re-clamps on resize and on content growth.

**A guessed height is not a substitute for a measurement.** `items.length * 28`, a hardcoded `maxHeight` reused as a clamp bound, `innerHeight - 200` — each drifts the moment a row is added, a label wraps, or the font size changes, and the drift is invisible until a menu hangs off the screen edge again. Measure.

Both primitives are zoom-aware. The operator's UI zoom is applied as `document.documentElement.style.zoom`, which means DOM measurements come back in real viewport pixels while CSS lengths are interpreted in the zoomed space. `viewport-zoom.ts` (`zoomRect` / `zoomViewport`) is the conversion; do not compare a raw `getBoundingClientRect()` against a CSS length without it.

`components/__tests__/popover-bounds-scan.test.ts` enforces this structurally: every `position: 'fixed'` in `renderer/components` and `renderer/studio` must resolve to `inset: 0`, the anchored positioner's output, a clamped ref, or a `// viewport-ok: <reason>` tag. A tag is for an element that is genuinely bounded some other way (a draggable panel with its own clamp, a corner-pinned toast) and must cite what bounds it.

## Subprocess env

- `CLAUDECODE` and similar leakage env vars are stripped before spawn (`main/cli-env.ts`). Don't bypass.
- **The launch environment is repaired before any other module loads** (`main/launch-env.ts`, imported first by `main/index.ts` through `main/launch-env-init.ts`). When the package installer launches Ion, the app inherits the Installer script environment — including `APPLE_PKGKIT_ESCALATING_ROOT`, which makes Apple's `/bin/zsh` and `/bin/bash` run with the PRIVILEGED option and skip **every** user startup file (`~/.zshenv`, `~/.zprofile`, `~/.zshrc`), regardless of shell arguments or PTY. That is what left panes with no Starship, no Zoxide, and none of the operator's PATH entries. The repair also restores the installer's `LOGNAME=root` / `SHELL=/bin/sh` identity and drops the deleted installer sandbox paths. Keep the `./launch-env-init` import first in `index.ts`: import declarations are hoisted, so a plain function call placed among them runs too late and `getCliPath()` would memoize a stripped PATH. `main/__tests__/launch-env-order.test.ts` pins this.
- `node-pty` is legacy (still in dependencies for existing terminals). New subprocess work goes through `terminal-manager.ts` patterns. Note: `engine-bridge.ts` is **not** a subprocess spawner — the engine is a persistent launchd daemon and the bridge only *connects* to its socket (`~/.ion/engine.sock`); it never spawns the engine.
- Every terminal PTY carries `ION_DESKTOP_TAB_ID`, `ION_DESKTOP_TERMINAL_INSTANCE_ID`, and `ION_DESKTOP_DEEPLINK_TOKEN`. Tools running in a pane read these to target their own conversation through `ion://` ([ADR-025](../docs/architecture/adr/025-deep-link-surface.md)). Don't drop them when touching `terminal-manager.ts`, and don't resolve a deep link's target conversation from the active tab — a pane must land where the request names, or be refused.

## Deep links (`ion://`)

`main/deeplink/` — one dispatcher, two transports (inline query params and a handoff file under `~/.ion/deeplink-requests/`), two actions (`terminal`, `prompt`). Reference: [`docs/configuration/deep-links.md`](../docs/configuration/deep-links.md).

The rules that bite when adding an action:

- **Never apply the trust check in an action.** `dispatch.ts` resolves the tier once, before routing; an action that re-checks (or forgets to) is how the gate gets bypassed.
- **A new action goes in the parser's allowlist** with per-field length caps. Unknown actions and over-long fields are refused, not truncated.
- **Untrusted requests must be fully described** in `DeepLinkConfirmDialog`. Show the real command or prompt text — a dialog that hides what it authorises trains the operator to approve blindly.
- **Every path that cannot obtain an answer resolves to declined.** No window, timeout, closed window. An untrusted terminal request without `tabId` is the explicit exception to strict targeting: its confirmation dialog must require the operator to choose a live conversation before approval; trusted requests without `tabId` are refused.


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

The Overlay Tab Strip contains a bell icon for global notifications (workspace-scoped resources). Ion Studio places the same bell in its title bar. The NotificationsPanel popover shows briefing resources sorted newest-first with read/unread tracking. When the user reads a briefing, the desktop sends a `mark_read` delta through the engine so iOS reflects the same state.

Session-scoped resources appear in the per-conversation attachments panel (ConversationAttachmentsSheet on iOS, equivalent on desktop).

## Studio shell rules (Overlay ↔ Studio parity)

**This is ONE client with two presentations.** The Desktop client renders through either the Overlay (the transparent glass window, `index.html`) or the Studio shell (the standalone workspace window, `studio.html`). They are presentations of one application, never two clients. Exactly one is active at a time (`activeUi`), and the Overlay renderer stays the session-store owner in both modes — when the Studio is active, the Overlay renderer runs hidden.

The Ion Studio window (`src/renderer/studio/`) runs the session store in MIRROR mode — see [ADR-021](../docs/architecture/adr/021-studio-shell-mirror-store.md) and `src/renderer/studio/README.md`. The rules that bite:

- **New store action** → classify in `src/shared/studio-mirror-actions.ts` (FORWARDED vs MIRROR_LOCAL with justification) or `mirror-parity.test.ts` fails.
- **Multi-step business flow** (approve-plan, implement, anything that reads store state between mutations) → ONE store action classified FORWARDED, never a component handler chaining store calls. A component handler runs in whichever window hosts it; in the mirror that mixes forwarded and local calls and its decisions read stale mirror state (the "Implement and Unpin filed under Planning" bug). `implementPlan` in `stores/slices/implement-slice.ts` is the pattern.
- **New event push from main** → route through `broadcast()`; `make check-studio-parity` fails direct `webContents.send` outside the owner-only allowlist in `scripts/check-studio-parity.sh`.
- **New shared surface** → mount the Overlay's component in the Studio shell (one component, one store); bespoke Studio widgets only for canvas-coupled surfaces.
- **Name it from the registry.** A shared concept — a surface, a state, an action, a UI region — uses its canonical term from `docs/vocabulary/terms.json` (the generated glossary is [`docs/vocabulary/index.md`](../docs/vocabulary/index.md)). A concept that has no entry yet gets one in the same change, with an implementation citing the real symbol and file; then run `make generate-vocabulary` and `make check-vocabulary`. A Studio-only region carries a Studio-qualified term (Studio Center, Studio Surface, Studio Left Dock) so it never reads as a shared surface.
- **New Studio setting** → `SETTINGS_DEFAULTS` + the `STUDIO_SETTING_KEYS` allowlist in `main/ipc/studio.ts` + `StudioSettings`; cross-window convergence rides `ion:settings-changed` from the settings funnel.
- **Surface tabs** (`src/renderer/studio/surface/`) live in a window-local Zustand store OUTSIDE useSessionStore. `studioSurface` persists one descriptor record per conversation, a source-project-scoped Scratch Document map, the global Diff/Plan/Visualizer pin set, and one workspace-scoped Notification tab. Opening a notification replaces that global tab's resource and it remains open across conversations until the user closes it. Normal file tabs stay conversation-scoped. An unsaved Scratch Document follows every conversation whose canonical editor directory resolves to the same source project, including its worktrees; saving removes that project record and opens a normal file tab only in the active conversation. Explorer, Git, browser, terminal, and file tabs never pin. The surface store selects the mirrored active conversation synchronously. Geometry remains global in `studioLayout`; the desktop preference controls whether visibility stays live across a tab switch or restores each conversation's saved state. Shape/ordering/persistence contracts are shared modules (`shared/studio-surface-*.ts`) — one parser is both the renderer restore and the main-side `studioSurface` validator. File tabs are descriptors whose buffers stay in `fileEditorStates`.
- **File-open routing** goes through `renderer/lib/file-open-router.ts`: Studio registers a router at boot, the Overlay never does — shared components ask `surfaceRouter()` first and keep their legacy fallback. Never add `windowRole()` branches to shared components for file-open behavior.
- **Single-UI exclusivity (D1)**: `activeUi` picks the ONE conversation UI; the live switch is `main/active-ui.ts`; the enterprise lock is `activeUiPolicy` (`shared/enterprise-active-ui-policy.ts`). Inactive-UI affordances are ABSENT, not disabled.
- **Terminals** are main-owned with the attach protocol (`TERMINAL_ATTACH`): renderers attach/detach, only explicit close destroys. The Conversation Terminal Panel is owner-controlled and mirrored between Overlay and Studio with identical terminal IDs, labels, order, selection, and visibility. Studio Surface terminals remain separate Studio-only descriptors with `<conversationId>:surface:<instanceId>` keys; `ion://terminal` never targets them.
- **Inbox**: the desktop computes inbox classification (`shared/inbox-classify.ts`); clients render. Settle/snooze/unread are FORWARDED tab-metadata actions; iOS parity rides `RemoteTabState.inboxState`/`unread`/`wokeAt` + the `desktop_tab_*` inbox commands.
- **User turns are echoed through ONE funnel.** A user turn does not ride engine events, so every surface that did not perform the optimistic insert must be told separately — the Studio mirror (`notifyStudioUserMessageEcho`) and iOS (`desktop_message_added`). Call `echoUserTurn` (`main/user-turn-echo.ts`); never send either directly. The funnel applies the injection classification (`shared/injection-policy.ts`), so a turn that must stay out of the transcript is hidden on **every** surface at once. `main/__tests__/user-turn-echo-funnel.test.ts` fails the build on a direct echo. **To add a hidden message class:** classify the kind in the engine (`engine/internal/types/injection_kind.go`) so `machineAuthored` carries it, and add it to `OUTBOUND_MACHINE_KINDS` in `shared/injection-policy.ts` only if a CLIENT authors it (on send the engine's flag does not exist yet). Do not add a check at a call site — that is the drift this funnel removes. **Hiding is for turns no human ever saw** (agent callbacks, background-task results). A turn the operator actually produced — a Guided Questions submission, where they chose the options and typed the text — stays visible and is LABELLED instead (`Message.injectionKind` → the tag in `MessageBubble.tsx`); hiding it drops real operator input from the transcript.

## Done criteria

While developing, follow the root [`AGENTS.md`](../AGENTS.md) § "Validation cadence — never after every file edit". Run a focused test after a logical batch when it can disprove the changed behavior. Run typecheck, lint, file-size checks, and the required scoped tests once when the implementation is stable. Do not rerun a successful gate unless later code changes could invalidate it. The full `npm test` suite and `npm audit` are heavy gates that run at PR time (CI is authoritative; `/create-pr` runs the Linux parity subset, which includes the full desktop test run, before pushing); do not run them mid-development.

1. `npm run typecheck` passes.
2. `npm run lint` passes with zero errors when touching renderer/ code. This enforces `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`, `react/no-unstable-nested-components`, and `no-console` — the structural gate against React error #185.
3. `npm test -- <pattern>` passes for the area you touched. The full `npm test` run is a heavy gate — it runs at PR time (CI is authoritative; `/create-pr` runs it inside the Linux container before pushing); don't run it repeatedly while iterating.
4. `make check-file-sizes` passes.
5. UI changes: smoke-tested in `npm run dev`. Report what was tested.
6. Don't `git push`.
7. **iOS parity check.** If the change affects a feature that exists on iOS (tab status, engine instances, permissions, working state), verify the iOS side is updated or document why it's deferred. See root `AGENTS.md` § "Cross-platform parity".
