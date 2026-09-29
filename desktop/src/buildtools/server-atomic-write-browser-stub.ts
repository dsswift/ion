/**
 * server-atomic-write-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/utils/atomicWrite.ts`.
 *
 * The real file calls `fs.openSync`/`fsyncSync`/`renameSync` to durably
 * persist server-owned files (settings, tabs, session chains, credentials,
 * bench state, and more). It has dozens of real importers across
 * `server/src/**`, all legitimately real for the server process, and is
 * reachable from the renderer transitively through several of them (e.g.
 * `persistence/tab-content-store.ts`, `automation/store.ts`,
 * `questions/questions-persistence.ts`) via `sessionStore.ts`'s reactive
 * selectors. A sandboxed renderer has no real filesystem to fsync against,
 * and every one of these persistence paths is server-owned per spec 17
 * ("server owns the store, Studio renders") — the renderer never performs
 * durable writes locally.
 *
 * `atomicWriteFileSync` throws rather than silently no-op, so an accidental
 * renderer-side write attempt fails loudly instead of pretending to
 * succeed. Wired in via `electron.vite.config.ts`'s renderer plugin, keyed
 * on atomicWrite.ts's resolved absolute path so every relative import of it
 * resolves here.
 */

export function atomicWriteFileSync(
  _path: string,
  _data: string | Uint8Array,
  _mode?: number,
): void {
  throw new Error(
    "atomicWriteFileSync() cannot run in the Studio renderer — file persistence is server-owned; route through a FORWARDED store action instead.",
  );
}
