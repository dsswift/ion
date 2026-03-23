# CODA

Electron desktop overlay for Claude Code. Transparent always-on-top window with click-through for non-UI regions.

## Architecture

- **Main process**: `src/main/index.ts` -- window management, IPC handlers, git operations
- **Preload**: `src/preload/index.ts` -- IPC bridge (`window.coda` API)
- **Renderer**: `src/renderer/` -- React + Zustand + Framer Motion UI
- **Shared types**: `src/shared/types.ts` -- types and IPC channel constants

IPC pattern: renderer calls `window.coda.method()` -> preload bridges via `ipcRenderer.invoke(IPC.CHANNEL, args)` -> main process handles via `ipcMain.handle(IPC.CHANNEL, handler)`.

## Build and Test

The user tests with the **packaged macOS app**, not the dev server.

### Build + install cycle

```bash
make install
```

This launches the installer as a **detached background process** (via `commands/install-bg.command`) so it returns immediately. The installer handles graceful shutdown (SIGUSR1 drain -- waits for active agents and bash commands to finish), build, copy to `/Applications`, and relaunch. Output is logged to `/tmp/coda-install.log`.

The detached design breaks the deadlock when developing CODA inside CODA: the agent's bash command returns immediately, the agent completes, the drain proceeds, and the orphaned installer continues.

**Never kill CODA processes directly or copy over the app bundle manually.** Always use `make install` or `bash commands/install-app.command` so that active agents finish gracefully before the binary is replaced.

### Key distinction

- `npm run build` -- builds to `dist/` only (dev server uses this, packaged app does NOT)
- `npm run dist` -- builds to `dist/` then packages into `release/mac-arm64/CODA.app`

**After any code change, you must run `make install` for the user to see changes.** Running `npm run build` alone will NOT update the installed app.

## Transparent Window + Click-Through

The app uses `setIgnoreMouseEvents` with `{ forward: true }` for OS-level click-through on transparent regions. The renderer toggles this on `mousemove` by checking if the cursor is over a `[data-coda-ui]` element. All interactive UI elements must be descendants of a `data-coda-ui` container.

## Conventions

- Colors: use `useColors()` from `src/renderer/theme.ts`
- Popovers: use `usePopoverLayer()` + `createPortal` (see `PopoverLayer.tsx`)
- State: Zustand store at `src/renderer/stores/sessionStore.ts`
- Icons: `@phosphor-icons/react`
- Animation: `framer-motion`
