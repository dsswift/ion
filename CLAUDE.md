# Clui CC

Electron desktop overlay for Claude Code. Transparent always-on-top window with click-through for non-UI regions.

## Architecture

- **Main process**: `src/main/index.ts` -- window management, IPC handlers, git operations
- **Preload**: `src/preload/index.ts` -- IPC bridge (`window.clui` API)
- **Renderer**: `src/renderer/` -- React + Zustand + Framer Motion UI
- **Shared types**: `src/shared/types.ts` -- types and IPC channel constants

IPC pattern: renderer calls `window.clui.method()` -> preload bridges via `ipcRenderer.invoke(IPC.CHANNEL, args)` -> main process handles via `ipcMain.handle(IPC.CHANNEL, handler)`.

## Build and Test

The user tests with the **packaged macOS app**, not the dev server.

### Build + install cycle

```bash
npm run dist                    # builds to release/mac-arm64/
# Then copy to /Applications:
cp -R "release/mac-arm64/Clui CC.app" "/Applications/Clui CC.app"
```

Or use the install script which does both:

```bash
bash install-app.command
```

### Key distinction

- `npm run build` -- builds to `dist/` only (dev server uses this, packaged app does NOT)
- `npm run dist` -- builds to `dist/` then packages into `release/mac-arm64/Clui CC.app`

**After any code change, you must run `npm run dist` and reinstall to `/Applications/` for the user to see changes.** Running `npm run build` alone will NOT update the installed app.

### Quick reinstall (skip whisper/setup)

```bash
pkill -9 -f "Clui CC" 2>/dev/null; sleep 1; npm run dist && rm -rf "/Applications/Clui CC.app" && cp -R "release/mac-arm64/Clui CC.app" "/Applications/Clui CC.app"
```

## Transparent Window + Click-Through

The app uses `setIgnoreMouseEvents` with `{ forward: true }` for OS-level click-through on transparent regions. The renderer toggles this on `mousemove` by checking if the cursor is over a `[data-clui-ui]` element. All interactive UI elements must be descendants of a `data-clui-ui` container.

## Conventions

- Colors: use `useColors()` from `src/renderer/theme.ts`
- Popovers: use `usePopoverLayer()` + `createPortal` (see `PopoverLayer.tsx`)
- State: Zustand store at `src/renderer/stores/sessionStore.ts`
- Icons: `@phosphor-icons/react`
- Animation: `framer-motion`
