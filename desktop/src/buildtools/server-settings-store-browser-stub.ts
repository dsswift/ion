/**
 * server-settings-store-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/persistence/settings-store.ts`.
 *
 * The real file is the server's settings/engine-config/tabs/session-label/
 * session-chain persistence layer: real `fs.readFileSync`/`existsSync`/
 * `mkdirSync` against real on-disk paths. It is unconditionally reachable
 * from every renderer file that imports the session store for its reactive
 * selectors (spec 17: Studio renders against the server-owned store) — many
 * slices call `readSettings()`/`readGitWatcherIgnoredDirectories()` etc.
 * directly rather than only through the HostApi barrel. Settings persistence
 * is server-owned; the renderer receives current settings over the
 * studio-wire (`desktop_settings_snapshot`/mirrored store state), never by
 * reading `settings.json` itself.
 *
 * `SETTINGS_DEFAULTS` is copied verbatim from the real file — it is a pure
 * literal with no I/O, and code that merges it into initial renderer state
 * needs the real default values, not an empty stand-in. Every path getter
 * returns a stable placeholder string (never touching `path`/`os`). Every
 * read returns a safe empty/default result; every write throws, so an
 * accidental renderer-side write attempt fails loudly instead of pretending
 * to persist. Wired in via `electron.vite.config.ts`'s renderer plugin,
 * keyed on settings-store.ts's resolved absolute path so every relative
 * import of it resolves here.
 */

function rejectWrite(name: string): never {
  throw new Error(
    `${name}() cannot run in the Studio renderer — settings persistence is server-owned; route through a FORWARDED store action instead.`,
  );
}

export function settingsDir(): string {
  return "/studio-renderer-stub/settings";
}
export function settingsFile(): string {
  return "/studio-renderer-stub/settings/settings.json";
}
export function engineConfigFile(): string {
  return "/studio-renderer-stub/settings/engine.json";
}
export function tabsFile(): string {
  return "/studio-renderer-stub/settings/tabs.json";
}
export function sessionLabelsFile(): string {
  return "/studio-renderer-stub/settings/session-labels.json";
}
export function sessionChainsFile(): string {
  return "/studio-renderer-stub/settings/session-chains.json";
}
export function legacyTabsFileForBackend(backend: "api" | "cli"): string {
  return `/studio-renderer-stub/settings/tabs-${backend}.json`;
}
export function legacySessionLabelsFileForBackend(backend: "api" | "cli"): string {
  return `/studio-renderer-stub/settings/session-labels-${backend}.json`;
}
export function legacySessionChainsFileForBackend(backend: "api" | "cli"): string {
  return `/studio-renderer-stub/settings/session-chains-${backend}.json`;
}

export const SETTINGS_DEFAULTS = {
  logLevel: "DEBUG",
  selectedTheme: "ion-dark",
  soundEnabled: true,
  defaultBaseDirectory: "",
  showDirLabel: true,
  preferredOpenWith: "cli",
  expandToolResults: false,
  terminalFontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  terminalFontSize: 13,
  showHiddenFiles: false,
  allowSettingsEdits: false,
  pushConversationTitles: true,
  enableClaudeCompat: false,
  // Empty, not an invented model id -- see server's SETTINGS_DEFAULTS.preferredModel.
  preferredModel: "",
  enableEarlyStopContinuation: false,
  showImplementClearContext: false,
  interceptEnabled: true,
  gitWatcherIgnoredDirectories: ["~/.ion"] as string[],
  workspaceFolders: {} as Record<string, string[]>,
  gitPanelRepoSectionsCollapsed: {} as Record<string, boolean>,
  inboxAutoSettleDays: 0,
  inboxAutoSettleOnMerge: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  projects: {} as Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defaultThinkingEffort: "medium" as any,
  studioTheme: "ion-works",
  studioZoom: 0,
  studioSeed: "",
  studioShortcut: "Alt+Shift+Space",
  studioHeat: false,
  studioPlaywrightEnabled: true,
  studioLayout: {
    leftSidebarVisible: false,
    leftSidebarView: "explorer",
    surfaceWidth: 520,
    terminalHeight: 240,
    dispatchSplitRatio: 0.45,
  },
  studioSurface: { version: 4, pinnedTabs: ["plan"], notification: null, conversations: {}, scratchProjects: {} },
  studioComposerStash: { version: 1, projects: {} },
  studioSound: true,
  studioBeacon: true,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readSettings(): Record<string, any> {
  return {};
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeSettings(_data: Record<string, any>): void {
  rejectWrite("writeSettings");
}

export function invalidateStreamThinkingToRemoteCache(): void {}
export function shouldStreamThinkingToRemote(): boolean {
  return true;
}
export function readClaudeCompat(): boolean {
  return SETTINGS_DEFAULTS.enableClaudeCompat;
}
export function readWorktreeBranchDefault(_repoPath: string): string | undefined {
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readEngineConfig(): Record<string, any> {
  return {};
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function writeEngineConfig(_config: Record<string, any>): void {
  rejectWrite("writeEngineConfig");
}
export function updateEngineConfig(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _mutator: (config: Record<string, any>) => boolean | void,
): boolean {
  rejectWrite("updateEngineConfig");
}
// The stub reads no engine.json, so there is nothing for a managed file to replace.
export function setManagedEngineConfigSource(_source: { path: string | null } | null): void {}
export class ManagedEngineConfigError extends Error {
  readonly code = "managed_config_write_refused";
}
export function ensureHybridBackendConfig(): boolean {
  rejectWrite("ensureHybridBackendConfig");
}

export function loadSessionLabels(): Record<string, string> {
  return {};
}
export function saveSessionLabels(_labels: Record<string, string>): void {}

export function loadSessionChains(): {
  chains: Record<string, string[]>;
  reverse: Record<string, string>;
} {
  return { chains: {}, reverse: {} };
}
export function saveSessionChains(_data: {
  chains: Record<string, string[]>;
  reverse: Record<string, string>;
}): void {}

export function readGitWatcherIgnoredDirectories(): string[] {
  return SETTINGS_DEFAULTS.gitWatcherIgnoredDirectories;
}
