# Desktop (Electron + React + Zustand)

The Electron shell and the Studio renderer. The session store, Studio wire, terminals, deep links, and engine bridge live in `server/`. Main spawns the server as a child process (`main/local-server.ts`, `LocalServerSupervisor`) and loads a few server modules directly; see `server/AGENTS.md`.

## Commands

```bash
npm run dev         # electron-vite dev (hot reload)
npm run build       # electron-vite build
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint: react-hooks rules, no-console in renderer/
npm test -- <pattern>
npm run doctor      # bash scripts/doctor.sh
```

Never kill the user's running dev server. Renderer changes hot-reload; main-process changes need a full `npm run dev` restart, so tell the user.

## Ion Desktop is not a web application

`npm run dev` starts Electron through `electron-vite`. There is no supported Ion page at `http://localhost:5173` or any browser URL. Never use `browser_navigate`, Playwright against a guessed localhost, or a web browser as proof the Desktop UI works. Visible verification uses the real Electron window; for a packaged build, the operator looks. Logs, snapshots, and tests are extra evidence, never a replacement. The Studio Browser is content inside Studio; its tools do not see the Desktop UI.

## Layout

```
desktop/src/
  main/          Electron shell: windows, lifecycle, updater, ipc/ (dialogs, browser views, Studio bridge)
  preload/       contextBridge surface
  renderer/      React app; studio/ is the app, components/ and hooks/ are shared UI,
                 stores/ holds window-local stores only
  shared/        desktop-only cross-process types
  buildtools/    renderer-server-stubs.ts (browser stubs for server modules the renderer bundles)
```

Cross-process types shared with the server and iOS live in `packages/shared/src/`.

## View readiness principle

Every view is complete and correct the moment it renders. Badge counts, list items, status dots, and metadata show current truth on first paint. Data already in the store is read synchronously. Data that needs a fetch either completes before render, or shows a loading state visibly distinct from "zero items". A badge that shows "1" and then "3" is a bug. Anything visible must also be in the iOS snapshot (or derivable from it).

## IPC

- The renderer reaches main only through `preload/`. It never imports from `main/`. A pure helper both sides need lives in `packages/shared/src/`.
- Validate `ipcMain` inputs with the helpers in `server/src/ipc-validation.ts`. Channels are namespaced by feature (`git:status`, `terminal:write`).
- No `executeJavaScript` with string interpolation. Use a preload function.

## Launch environment

`main/index.ts` imports `./launch-env-init` first. That runs `@ion/server/launch-env` before any other module reads `process.env`. An Installer-launched app inherits `APPLE_PKGKIT_ESCALATING_ROOT`, which makes `/bin/zsh` and `/bin/bash` skip every user startup file, so panes lose PATH, Starship, and Zoxide. A plain call among the imports runs too late, because imports are hoisted. `main/__tests__/launch-env-order.test.ts` pins this.

## Renderer conventions

- `useColors()` for every color. `renderer/theme/hardcoded-colors-scan.test.ts` fails on untagged literals. Interaction states and tokens: [docs/design/desktop-style-guide.md](../docs/design/desktop-style-guide.md).
- Phosphor icons (`@phosphor-icons/react`) only.
- `<Tooltip text="...">` (`components/git/Tooltip.tsx`), never the HTML `title` attribute.
- Framer Motion for animation.
- Narrow Zustand selectors with equality functions; no whole-store subscriptions.
- Anything portaled into `PopoverLayer` (`components/PopoverLayer.tsx`) sets `pointerEvents: 'auto'` on its root. The layer is `pointerEvents: 'none'`, so without it clicks pass through silently.

## Popover positioning

Every popover, menu, tooltip, and picker lands fully inside the window.

| Anchor | Primitive |
|---|---|
| A point (`anchor: { x, y }`, "below this trigger") | `useAnchoredPopover` (`hooks/useAnchoredPopover.ts`): measures and flips before paint. Gate on `visibility: pos.ready ? 'visible' : 'hidden'`; put everything that changes height in `deps`. |
| An edge (`bottom:` / `right:` from a trigger rect) | `useViewportClamp` (`hooks/useViewportClamp.ts`): corrects after layout with CSS `translate`, re-clamps on resize and growth. |

- Measure. A guessed height (`items.length * 28`, `innerHeight - 200`) drifts.
- UI zoom is `document.documentElement.style.zoom`. Convert with `viewport-zoom.ts` (`zoomRect`, `zoomViewport`, `zoomAnchorEdges`). Never spend `window.innerHeight - rect.top` as a CSS length.
- `components/__tests__/popover-bounds-scan.test.ts` requires every `position: 'fixed'` in `renderer/components` and `renderer/studio` to resolve to `inset: 0`, the positioner output, a clamped ref, or a `// viewport-ok: <reason>` tag naming what bounds it.

## Platform portability

Targets are macOS and Windows. Every `process.platform === 'darwin'` guard needs a `win32` branch or a logged skip. Use `path.delimiter` for PATH, `packages/shared/src/paths.ts` (`isAbsolutePath`, `pathSegments`, `joinPath`) for native paths, and `renderer/platform/mod-key.ts` (`isModKey`, `IS_MAC`) for the command key. No `/bin/*`, `/opt/*`, or `/usr/*` literal outside a darwin or linux branch. A test pinning darwin behavior pins win32 for the same seam.

## Studio shell rules

Studio is the desktop's only window. It boots the server's store against the local environment through `renderer/studio/state/secondary-store.ts` (root `AGENTS.md` § "Server owns the store, Studio renders").

- **Multi-step flows are single store actions**, never component handlers. A handler runs in whichever window hosts it, mixes forwarded and local calls, and decides against stale mirror state.
- **No session logic in `desktop/src/main`.** `grep -rn "sessionStore" desktop/src/main` stays at 0.
- **Surface tabs** (`renderer/studio/surface/`) live in a window-local store outside `useSessionStore`. Shape, ordering, and persistence contracts are shared modules; one parser serves the renderer restore and the persisted-state validator. File tabs are descriptors; buffers stay in `fileEditorStates`. Pin and scope rules: [docs/architecture/desktop.md](../docs/architecture/desktop.md) § "Studio Surface".
- **File-open routing** goes through `renderer/lib/file-open-router.ts`. Shared components ask `surfaceRouter()` first.
- **The Inbox is the one conversation surface.** A conversation verb goes on the row menu (`studio/inbox/InboxRowMenu.tsx`). Its visibility and enablement live in a gate hook (`useConvertToWorktreeGate`, `useTransferGate`); the menu calls the store action. Pin each verb with a test beside the menu (`InboxRowMenu-transfer.test.tsx`).

## Logging

`~/.ion/desktop.jsonl`, `component=desktop`.

- Main: `main/logger.ts`. Server modules main loads directly land here through `main/server-logger-adapter.ts`; the server child writes `server.jsonl`.
- Crashes: `main/crash-logging.ts` records uncaught exceptions and unhandled rejections, drains the buffer, then shows Electron's usual dialog.
- Renderer: `renderer/rendererLogger.ts` (`rInfo`, `rDebug`, `rWarn`, `rError`, `rTrace`). It cannot import `main/logger.ts`. Use `rTrace`/`rDebug` for per-frame or per-chunk lines.

## Packaged app

- `npm run dist` ends with `scripts/check-packaged-requires.js`: it loads every module the main, preload, and server bundles name from inside the asar, and checks node-pty's spawn-helper execute bit. There is deliberately no launch test; a boot exception is read from `desktop.jsonl`.
- DevTools do not open in a packaged build. Never ask the user to check the console. Add `rendererLogger` lines or a field on the snapshot projection (`server/src/remote/snapshot.ts`) first, then ask the user to reproduce on a new build. Live DevTools need `npm run dev`.

## Done criteria

1. `npm run typecheck`, `npm run lint` (for renderer code), and `npm test -- <pattern>` for the touched area pass.
2. `make check-file-sizes` passes.
3. UI changes are checked in the real Electron window. Report what was checked.
4. A feature that also exists on iOS is updated there in the same change, or the report says why it cannot apply (root `AGENTS.md` § "Cross-platform parity").
