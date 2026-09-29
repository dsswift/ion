/**
 * HostApi — the server-side replacement for the desktop preload's
 * `window.ion.*` contextBridge surface.
 *
 * The moved session store (`server/src/store/**`) was written against a
 * preload bridge that round-tripped every call through Electron IPC to a
 * `BrowserWindow`. The server runs headless with no window and no bridge:
 * every slice that called `window.ion.<method>(...)` now imports the
 * matching function from this barrel instead. Each function delegates to
 * the SAME underlying implementation the desktop's `ipcMain.handle`
 * registrations called — behavior is unchanged, only the transport is
 * removed. Split into domain files at the file-size cap:
 * `host-api-engine.ts` (engine/tab/prompt lifecycle), `host-api-git.ts`
 * (git/worktree/bench), `host-api-project.ts` (a project's committed
 * config), `host-api-misc.ts` (terminal/resource/everything else).
 */
export * from './host-api-engine'
export * from './host-api-git'
export * from './host-api-misc'
export * from './host-api-project'
