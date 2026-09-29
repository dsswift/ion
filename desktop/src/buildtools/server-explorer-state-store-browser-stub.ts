/**
 * server-explorer-state-store-browser-stub — the Studio renderer's
 * build-time replacement for `server/src/explorer-state-store.ts`.
 *
 * The real file is the one owner of file-explorer tree state, persisted to
 * `~/.ion/explorer-state.json` (`fs.readFileSync`/`atomicWriteFileSync`). It
 * is reachable from the renderer transitively through
 * `store/explorer-state-sync.ts` via `sessionStore.ts`'s reactive
 * selectors. Per the real file's own docs, "Studio and any other attached
 * client are windows onto one workbench... The server holds the snapshot" —
 * the renderer never persists explorer state itself, only receives it.
 *
 * `loadExplorerState` returns the shared empty-state constant so callers see
 * a well-formed snapshot rather than undefined; every mutating function is
 * an inert no-op/passthrough. Wired in via `electron.vite.config.ts`'s
 * renderer plugin, keyed on explorer-state-store.ts's resolved absolute path
 * so every relative import of it resolves here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExplorerStateSnapshot = any;

const EMPTY: ExplorerStateSnapshot = { expanded: {}, selection: {} };

export function explorerStateFile(): string {
  return "/studio-renderer-stub/settings/explorer-state.json";
}

export function loadExplorerState(): ExplorerStateSnapshot {
  return EMPTY;
}

export function saveExplorerState(next: ExplorerStateSnapshot): ExplorerStateSnapshot {
  return next;
}

export function forgetExplorerState(_directory: string): {
  snapshot: ExplorerStateSnapshot;
  changed: boolean;
} {
  return { snapshot: EMPTY, changed: false };
}

export function resetExplorerStateCache(): void {}
