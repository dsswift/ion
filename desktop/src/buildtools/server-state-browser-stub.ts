/**
 * server-state-browser-stub — the Studio renderer's build-time replacement
 * for `server/src/state.ts`.
 *
 * `server/src/state.ts` constructs real infrastructure at module scope
 * (`new EngineBridge()`, `new EngineControlPlane(...)`, `new PairingManager()`,
 * `new RelayDiscovery()`) — real sockets, `execFileSync` engine discovery,
 * pairing crypto. That is correct for the server process, which is the one
 * real writer and the one thing that should hold a live engine connection.
 * It is unconditionally reachable from every renderer file that imports the
 * session store for its reactive selectors (spec 17: Studio renders against
 * the server-owned store), and a sandboxed Electron renderer can run none of
 * that Node infrastructure — nor should it try to: FORWARDED store actions
 * already round-trip to the server over the studio-wire (`secondary-store.ts`)
 * instead of touching a local engine connection, so nothing in the renderer's
 * real code path should ever need a genuine `engineBridge`/`sessionPlane`.
 *
 * This stub mirrors state.ts's exported shape with inert defaults: empty
 * Maps/Sets, null caches, and Proxy-based EventEmitter-shaped objects for
 * the class instances (`engineBridge`, `sessionPlane`, `pairingManager`,
 * `relayDiscovery`) whose methods return `undefined`/a resolved no-op rather
 * than perform real I/O, so an accidental call fails loudly at the type
 * level (or quietly no-ops) rather than throwing at renderer boot. Wired in
 * via `electron.vite.config.ts`'s renderer plugin, keyed on `state.ts`'s
 * resolved absolute path so every relative import of it resolves here.
 */

/** Any method call on this resolves to a no-op; any property read resolves to undefined. */
function inertInstance<T extends object>(): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined; // never mistaken for a thenable
        return (..._args: unknown[]) => undefined;
      },
    },
  ) as T;
}

export const DEBUG_MODE = false;
export const SPACES_DEBUG = false;

export interface FileWatcherEntry {
  watcher: unknown;
  refCount: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const engineBridge: any = inertInstance();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sessionPlane: any = inertInstance();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pairingManager: any = inertInstance();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const relayDiscovery: any = inertInstance();

export const bashProcesses = new Map<string, unknown>();
export const fileWatchers = new Map<string, FileWatcherEntry>();
export const recentlyWrittenPaths = new Set<string>();
export const activeAssistantMessages = new Map<string, { id: string; content: string }>();
export const lastMessagePreview = new Map<string, string>();
export const terminalOutputAccumulator = new Map<string, string>();
export const terminalScrollback = new Map<string, string>();
export const MAX_SCROLLBACK_SIZE = 100_000;

interface MutableState {
  remoteTransport: unknown | null;
  forceQuit: boolean;
  toggleSequence: number;
  screenshotCounter: number;
  cachedFonts: string[] | null;
  terminalOutputFlushTimer: ReturnType<typeof setInterval> | null;
  tabSnapshotInterval: ReturnType<typeof setInterval> | null;
  rendererSnapshotCache: unknown | null;
  remoteWorktreeStates: Map<string, unknown>;
  studioActiveTabId: string | null;
  studioActiveProfileId: string | null;
}

export const state: MutableState = {
  remoteTransport: null,
  forceQuit: false,
  toggleSequence: 0,
  screenshotCounter: 0,
  cachedFonts: null,
  terminalOutputFlushTimer: null,
  tabSnapshotInterval: null,
  rendererSnapshotCache: null,
  remoteWorktreeStates: new Map(),
  studioActiveTabId: null,
  studioActiveProfileId: null,
};

export const modelCache = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  models: [] as any[],
  lastFetched: 0,
};

export const enterprisePolicyCache = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  policy: null as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  newConversationDefaults: null as any,
};

export const extensionCommandRegistry = new Map<string, Set<string>>();
export const deviceFocusMap = new Map<string, { tabId: string | null; interceptEnabled: boolean }>();
export const forwardedEnginePermissionDenials = new Set<string>();
export const lastForwardedTabStatus = new Map<string, string>();
export const lastForwardedTabMeta = new Map<string, number>();
