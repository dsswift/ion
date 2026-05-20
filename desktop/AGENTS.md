# Desktop (Electron + React + Zustand)

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

## Layout

```
desktop/src/
  main/                    Electron main process
    index.ts               (4500-line god file, decomposing in Phase 2)
    ipc/                   per-feature IPC handlers (post-decomp)
    remote/                relay/LAN transport, pairing, crypto
    cli-compat/            CLI tool compatibility shims
    utils/                 atomicWrite, secretStore
  preload/                 contextBridge IPC surface
  renderer/                React app
    App.tsx                root (1100 lines, Phase 2)
    stores/sessionStore.ts (3500-line god file, Phase 3 → slices/)
    components/            UI (flat)
    hooks/                 React hooks
  shared/types.ts          cross-process types
```

## File-architecture rules

- 600-line cap per `.ts`/`.tsx`. CI hard-fails above.
- Co-locate tests as `Foo.test.tsx` next to `Foo.tsx`. Existing `__tests__/` migrates per phase.
- Existing god files (`main/index.ts`, `stores/sessionStore.ts`, `TabStrip.tsx`, `GitPanel.tsx`, `App.tsx`) are allowlisted. Do not extend; extract new modules.

## IPC

- All `ipcMain.handle/on` channels validated via `main/ipc-validation.ts` patterns. No exceptions.
- Channels namespaced by feature: `session:start`, `git:status`, `terminal:write`, etc.
- Renderer reaches IPC only through `preload/`. Renderer must not import from `main/`.
- Avoid `executeJavaScript` with string interpolation. Use preload-bridge functions.

## State

- Zustand. Single store today, splitting into slices in Phase 3.
- Cross-slice actions live at root; don't reach across slices.
- User-state persistence (tabs, labels, settings) goes through `main/utils/atomicWrite.ts`. Never `writeFileSync` directly.

## Renderer conventions

- `useColors()` for all color references. Never hardcode color values (breaks theming).
- Phosphor icons (`@phosphor-icons/react`). Don't add other icon libraries.
- Use `<Tooltip text="...">` (from `components/git/Tooltip.tsx`) instead of the HTML `title` attribute. Native tooltips render behind the Electron overlay. The Tooltip component portals through PopoverLayer.
- Framer Motion for animations.
- Narrow Zustand selectors with custom equality functions; avoid whole-store subscriptions.

## Subprocess env

- `CLAUDECODE` and similar leakage env vars are stripped before spawn (`main/cli-env.ts`). Don't bypass.
- `node-pty` is legacy (still in dependencies for existing terminals). New subprocess work goes through `engine-bridge.ts` / `terminal-manager.ts` patterns.

## Hot reload

- Renderer changes hot-reload.
- Main-process changes require full restart of `npm run dev`. Tell the user — don't try to monkey-patch.

## Logging

- Use `main/logger.ts`. No `console.log` in shipped code.
- No silent `catch {}`. Either log at debug (intentional fallback), increment a counter (parse-loop tolerance), or escalate to `error`.

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

## Done criteria

1. `npm run typecheck` passes.
2. `npm test` passes.
3. `make check-file-sizes` passes.
4. UI changes: smoke-tested in `npm run dev`. Report what was tested.
5. Don't `git push`.
