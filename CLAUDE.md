# CODA

Electron desktop overlay for Claude Code. Transparent always-on-top window with click-through for non-UI regions.

## Architecture

- **Main process**: `src/main/index.ts` -- window management, IPC handlers, git operations
- **Preload**: `src/preload/index.ts` -- IPC bridge (`window.coda` API)
- **Renderer**: `src/renderer/` -- React + Zustand + Framer Motion UI
- **Shared types**: `src/shared/types.ts` -- types and IPC channel constants

IPC pattern: renderer calls `window.coda.method()` -> preload bridges via `ipcRenderer.invoke(IPC.CHANNEL, args)` -> main process handles via `ipcMain.handle(IPC.CHANNEL, handler)`.

## Build and Test

The user tests with the **packaged macOS app**, not the dev server. Multiple worktrees may be open simultaneously, so the user controls which worktree gets installed.

### Build verification (agent responsibility)

After code changes, run `npm run build` to verify the build compiles cleanly. If the build succeeds, tell the user it's ready for testing. **Do NOT run `make install`** -- the user will run it themselves from the appropriate worktree.

### Install cycle (user-initiated only)

```bash
make install
```

This launches the installer as a **detached background process** (via `commands/install-bg.command`) so it returns immediately. The installer handles graceful shutdown (SIGUSR1 drain -- waits for active agents and bash commands to finish), build, copy to `/Applications`, and relaunch. Output is logged to `/tmp/coda-install.log`.

**Never kill CODA processes directly or copy over the app bundle manually.** Always use `make install` or `bash commands/install-app.command` so that active agents finish gracefully before the binary is replaced.

### Key distinction

- `npm run build` -- builds to `dist/` only (verifies compilation)
- `npm run dist` -- builds to `dist/` then packages into `release/mac-arm64/CODA.app`
- `make install` -- full build + package + install to `/Applications` + relaunch (user-initiated only)

## Transparent Window + Click-Through

The app uses `setIgnoreMouseEvents` with `{ forward: true }` for OS-level click-through on transparent regions. The renderer toggles this on `mousemove` by checking if the cursor is over a `[data-coda-ui]` element. All interactive UI elements must be descendants of a `data-coda-ui` container.

## Conventions

- Colors: use `useColors()` from `src/renderer/theme.ts`
- Popovers: use `usePopoverLayer()` + `createPortal` (see `PopoverLayer.tsx`)
- State: Zustand store at `src/renderer/stores/sessionStore.ts`
- Icons: `@phosphor-icons/react`
- Animation: `framer-motion`
