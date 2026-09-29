import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { dataDir } from "../paths";
import { log as _log, warn as _warn } from "../logger";
import { atomicWriteFileSync } from "../utils/atomicWrite";
import {
  encryptSensitiveSettings,
  decryptSensitiveSettings,
} from "../utils/secretStore";
import { expandHome } from "../git/ignore-paths";
import type { ThinkingEffort } from "@ion/shared/types-session";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn("main", msg, fields);
}

/**
 * Resolved fresh on every call, never cached at module scope: a module-scope
 * `= dataDir()` runs the moment anything imports this file, which breaks any
 * bundle target that cannot run real Node fs/path/os at import time (the
 * Studio renderer imports the session store, which imports this file
 * transitively, for its reactive selectors — see sessionStore.ts's
 * activateServerPersistence). Also lets ION_DATA_DIR be honored even when a
 * test sets it after this module was first imported.
 */
export function settingsDir(): string {
  return dataDir();
}
export function settingsFile(): string {
  return join(settingsDir(), "settings.json");
}
export function engineConfigFile(): string {
  return join(settingsDir(), "engine.json");
}

export const SETTINGS_DEFAULTS = {
  /**
   * Minimum log level the DESKTOP writes to ~/.ion/desktop.jsonl. The server's own level is its server.json's `logLevel`.
   *
   * DEBUG by default: this is a development machine, and the packaged build
   * has no DevTools, so `desktop.jsonl` is the only channel for diagnosing a
   * renderer or main-process problem. INFO-only logging repeatedly cost a
   * whole debugging round — an rDebug line placed to explain a scroll or
   * measurement decision was filtered out, so its absence looked like the
   * code path had not run. Verbose-but-present beats terse-and-blind.
   *
   * TRACE is available for per-frame diagnostics but is not the default: it is
   * loud enough to rotate the window that holds the evidence.
   */
  logLevel: "DEBUG",
  selectedTheme: "ion-dark",
  soundEnabled: true,
  defaultBaseDirectory: "",
  showDirLabel: true,
  preferredOpenWith: "cli",
  expandToolResults: false,
  // Must stay in sync with DEFAULT_MONO_FONT in renderer/typography.ts. This
  // was a macOS-only stack ("Menlo, Monaco, monospace"): on Windows none of
  // those fonts exist, so the browser substituted a PROPORTIONAL fallback.
  // xterm derives its column count from measured character width, so a
  // proportional font made every column far too wide and the terminal wrapped
  // at roughly a third of its pane. Cascadia Code ships with Windows Terminal
  // and Consolas with Windows itself.
  terminalFontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  terminalFontSize: 13,
  // Show dotfiles and OS-hidden entries in the file explorer. Off by default
  // so a tree opens on the operator's own files rather than on AppData and
  // .git. Hidden entries render dimmed when shown, so the distinction stays
  // visible rather than being all-or-nothing.
  showHiddenFiles: false,
  allowSettingsEdits: false,
  // A push names its conversation. Off sends generic text instead.
  pushConversationTitles: true,
  // Claude Code compatibility is a migration feature, not a default: .claude
  // roots (commands, skills, CLAUDE.md context) load only when the user
  // explicitly enables it. Greenfield installs are .ion-only.
  enableClaudeCompat: false,
  // Deliberately empty, not a specific model id. A device-local preference
  // default has no way to know what the operator actually configured
  // (engine.json's own provider/defaultModel); inventing one here silently
  // picks a provider that may have no key at all on this deployment. Empty
  // means "let the engine apply its own configured default, or correctly
  // refuse with its own clear error when neither exists."
  preferredModel: "",
  // Early-stop continuation nudge: when the model emits end_turn below the
  // configured output-token target, ask it to keep working. Default OFF per
  // ADR-002 2026-05-25 amendment (the feature is opt-in; users who want the
  // nudge enable it in General settings or via the Remote settings row).
  // See engine/early-stop-policy.ts for the policy that consumes
  // this setting.
  enableEarlyStopContinuation: false,
  // Show the secondary "Implement, clear context" button on the plan-
  // approval card. Default OFF — the regular Implement button always
  // preserves the engine conversation across the plan→implement
  // boundary so the model retains what it learned during planning. The
  // clear-context action is opt-in per-plan (per-click), not a global
  // forced behavior. Users can also `/clear` manually at any time. See
  // desktop/src/renderer/components/PermissionDeniedCard.tsx for the
  // button reveal and implementPlan (implement-slice.ts) for
  // the branching behavior.
  showImplementClearContext: false,
  // Whether the desktop acts on "redirect" level engine_intercept events —
  // aborting the active run and re-prompting with the intercept message.
  // Default ON. When false, redirect-level intercepts are downgraded to
  // banner (the event still renders in the conversation but the run is not
  // interrupted). Banner-level intercepts are always displayed regardless.
  // iOS has its own independent preference stored in UserDefaults.
  interceptEnabled: true,
  // Directories where the git file watcher is suppressed. The panel still
  // refreshes on focus, tab switch, and manual refresh. Supports ~ and $HOME
  // expansion. Default excludes ~/.ion (high-write log/conversation storage).
  gitWatcherIgnoredDirectories: ["~/.ion"] as string[],
  // Multi-root workspace folders, per-project: normalized primary/base dir
  // → extra roots shown in the explorer and git panel. Machine-local
  // absolute paths — never projectable to iOS.
  workspaceFolders: {} as Record<string, string[]>,
  // Per-repo collapse state of git-panel repo sections.
  gitPanelRepoSectionsCollapsed: {} as Record<string, boolean>,
  // Inbox auto-settle: days of inactivity before an idle conversation
  // files itself. 0 = off. Projectable (user preference, group 'tabs').
  inboxAutoSettleDays: 0,
  inboxAutoSettleOnMerge: true,
  // Project registry (G1): known base dirs, auto-populated from
  // conversation tabs + manual adds. Machine-local paths — never
  // projectable (iOS derives chips from tab workingDirectory).
  // repoRemote (spec 10): the project's canonical `host/org/repo` identity,
  // lazily resolved from `git remote get-url origin` the first time a
  // transfer needs it (server/src/transfer/repo-remote.ts). Absent until then.
  projects: {} as Record<string, { name?: string; addedManually: boolean; lastUsedAt: number; repoRemote?: string }>,
  // Per-conversation thinking effort default for effort-based models.
  // 'medium' is the ship default: it is the level that buys real reasoning
  // without pinning every trivial turn to the model's deepest budget, which
  // is latency the turn does not earn. Users can override in Settings, and
  // per-conversation changes live on the instance (StatusBarThinkingPicker).
  defaultThinkingEffort: "medium" as ThinkingEffort,
  // Ion Studio (desktop-only window; none of these keys are iOS
  // projectable). studioSeeds maps an extension scope (engineProfileId, or
  // 'local' for plain tabs) to a user-chosen office seed string.
  studioTheme: "ion-works",
  // 0 = fit-to-window (default); 1..6 = manual integer zoom.
  studioZoom: 0,
  // One office seed for the whole desktop ('' = built-in default). The
  // office layout is the user's office — identical across conversations.
  studioSeed: "",
  // Global shortcut toggling the Studio shell (Electron accelerator; '' = none).
  studioShortcut: "Alt+Shift+Space",
  // Footstep-heat overlay on the Studio window canvas (traffic visualization).
  studioHeat: false,
  // Enables client-side Playwright browser tools when Studio is active. It
  // never closes visible browser tabs or deletes their persistent session.
  studioPlaywrightEnabled: true,
  // Studio shell geometry. Pane visibility is owned by its content: the bottom
  // terminal uses per-conversation session-store state, and surface visibility
  // is saved with each conversation in studioSurface.
  studioLayout: {
    leftSidebarVisible: false,
    leftSidebarView: "explorer",
    surfaceWidth: 520,
    terminalHeight: 240,
    dispatchSplitRatio: 0.45,
  },
  // Studio surface records by conversation plus core tabs pinned across them.
  studioSurface: { version: 4, pinnedTabs: ['plan'], notification: null, conversations: {}, scratchProjects: {} },
  studioComposerStash: { version: 1, projects: {} },
  // Ambient soundscape in the Studio window (procedurally synthesized; mute toggle
  // in the control bar — office users need one-click silence).
  studioSound: true,
  // Dock bounce + title prefix when a permission arrives while the Studio window is
  // open but unfocused.
  studioBeacon: true,
};

export function readSettings(): Record<string, any> {
  if (!existsSync(settingsFile())) return {};
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), "utf-8"));
    return decryptSensitiveSettings(raw);
  } catch (err) {
    log("settings_store: failed to read settings", { error: String(err) });
    return {};
  }
}

export function writeSettings(data: Record<string, any>): void {
  if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true });
  const encrypted = encryptSensitiveSettings(data);
  atomicWriteFileSync(settingsFile(), JSON.stringify(encrypted, null, 2), 0o600);
  // Any settings write may have flipped a hot-path-cached projectable flag.
  // Invalidate the cache here, at the single write helper, so the next read
  // re-pulls from disk. Cheap (clears a primitive); correctness over saving
  // one disk read.
  const streamedBefore = streamThinkingCache;
  invalidateStreamThinkingToRemoteCache();
  if (streamedBefore !== null && streamedBefore !== shouldStreamThinkingToRemote()) {
    log("settings_store: streamThinkingToRemote changed", { enabled: !streamedBefore });
    for (const listener of [...streamThinkingListeners]) listener();
  }
}

// ─── streamThinkingToRemote hot-path cache (issue #158) ───
//
// `streamThinkingToRemote` (default true) gates whether a thin client's
// transcript carries the text of thinking rows. It is read every time a
// transcript is projected for the wire, which is many times per second while
// a reply streams. Re-reading settings.json from disk each time would be
// wasteful, so we cache the resolved boolean and invalidate it on every
// settings write (the single funnel above).
let streamThinkingCache: boolean | null = null;

const streamThinkingListeners = new Set<() => void>();

/**
 * Run `listener` whenever a settings write flips `streamThinkingToRemote`.
 * Returns the unsubscribe. The transcript publishers re-publish their rows,
 * so thinking text a phone was not sent appears when the setting turns on.
 */
export function onStreamThinkingToRemoteChange(listener: () => void): () => void {
  streamThinkingListeners.add(listener);
  return () => streamThinkingListeners.delete(listener);
}

/** Drop the cached `streamThinkingToRemote` value; next read re-pulls disk. */
export function invalidateStreamThinkingToRemoteCache(): void {
  streamThinkingCache = null;
}

/**
 * Resolve `streamThinkingToRemote` from settings.json, cached for the hot
 * forward path. Defaults to `true` (stream ON) when the key is absent or
 * not a boolean — matching SETTINGS_DEFAULTS. The cache is invalidated by
 * `writeSettings`, which also tells `onStreamThinkingToRemoteChange` listeners.
 */
export function shouldStreamThinkingToRemote(): boolean {
  if (streamThinkingCache !== null) return streamThinkingCache;
  const raw = readSettings();
  const v = raw.streamThinkingToRemote;
  // Default ON: only an explicit `false` disables streaming.
  streamThinkingCache = v === false ? false : true;
  return streamThinkingCache;
}

/**
 * Resolve the user's "Claude Code Compatibility" setting from settings.json.
 * Defaults to SETTINGS_DEFAULTS.enableClaudeCompat when the key is absent or
 * not a boolean. This gates whether the engine honors the `.claude` /
 * `~/.claude` roots (commands AND skills) during slash discovery + resolution —
 * the desktop reads the setting and hands it to the engine, which holds no
 * opinion on it. A read failure falls back to the default rather than silently
 * flipping behavior; callers log the value they pass.
 */
export function readClaudeCompat(): boolean {
  try {
    const v = readSettings().enableClaudeCompat;
    return typeof v === "boolean" ? v : SETTINGS_DEFAULTS.enableClaudeCompat;
  } catch {
    return SETTINGS_DEFAULTS.enableClaudeCompat;
  }
}

/**
 * Resolve the operator's default worktree source branch for a repo, recorded in
 * settings.json under `worktreeBranchDefaults` (keyed by source-repo path, set
 * from Git settings or the "set as default" checkbox at worktree setup).
 *
 * This is the value the desktop uses to SKIP the branch picker when creating a
 * worktree conversation (tab-slice-worktree-resolve.ts resolves
 * `sourceBranch || worktreeBranchDefaults[dir]`, and only the absence of a
 * default defers to the picker). `worktreeBranchDefaults` is a renderer
 * preference deliberately excluded from projectable settings, so iOS never saw
 * it and always prompted. Reading it here lets the worktree-state projection
 * carry the resolved default to iOS so the phone makes the same decision.
 *
 * Returns undefined when none is recorded or the stored value is not a
 * non-empty string.
 */
export function readWorktreeBranchDefault(repoPath: string): string | undefined {
  const raw = readSettings().worktreeBranchDefaults;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const v = (raw as Record<string, unknown>)[repoPath];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function readEngineConfig(): Record<string, any> {
  try {
    if (existsSync(engineConfigFile())) {
      return JSON.parse(readFileSync(engineConfigFile(), "utf-8"));
    }
  } catch (err) {
    // A corrupt engine.json silently yields empty config and downstream reads
    // defaults with no trace — log the failure.
    warn("settings: engine config read failed", { error: String(err) });
  }
  return {};
}

export function writeEngineConfig(config: Record<string, any>): void {
  if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true });
  atomicWriteFileSync(
    engineConfigFile(),
    JSON.stringify(config, null, 2),
    0o644,
  );
}

/**
 * Serialized read-mutate-atomic-write for engine.json. The mutator receives
 * the current config object and mutates it in place. All callers that need to
 * update engine.json should use this instead of separate readEngineConfig /
 * writeEngineConfig calls — it eliminates the TOCTOU gap between read and
 * write within the single desktop process.
 *
 * The mutator may return `false` to signal "no change needed," in which case
 * the write is skipped (avoids config churn that would force an unnecessary
 * daemon restart). Any other return (void, undefined, true) writes.
 *
 * Returns true when engine.json was written, false when skipped.
 */
export function updateEngineConfig(
  mutator: (config: Record<string, any>) => boolean | void,
): boolean {
  const cfg = readEngineConfig()
  const result = mutator(cfg)
  if (result === false) return false
  writeEngineConfig(cfg)
  return true
}

/**
 * Ensure engine.json selects the hybrid backend. The desktop's opinion is
 * credential-based per-provider routing (api-key-wins → authed CLI → api),
 * which the engine only applies under `backend: "hybrid"` — the engine's own
 * default stays `api` for external/headless consumers, so the desktop opts in
 * explicitly here (settings live with their owner, engine-grounding §6).
 * Returns true when the value changed (caller restarts the daemon so the
 * running engine re-reads the config).
 */
export function ensureHybridBackendConfig(): boolean {
  return updateEngineConfig((cfg) => {
    if (cfg.backend === 'hybrid') return false
    const previous = cfg.backend ?? '(unset)'
    cfg.backend = 'hybrid'
    log('settings_store: engine backend set to hybrid', { previous })
  })
}

/**
 * Unified tab/label/chain storage. One file each, independent of which
 * backend serves any given conversation — a credential or routing change can
 * never make tabs "disappear" by pointing the loader at a different file.
 * The legacy per-backend files below are read-only inputs to the one-time
 * merge migration (tab-backend-merge.ts) and to the cleanup guards during
 * the migration window; nothing writes them anymore.
 */
export function tabsFile(): string {
  return join(settingsDir(), "tabs.json");
}
export function sessionLabelsFile(): string {
  return join(settingsDir(), "session-labels.json");
}
export function sessionChainsFile(): string {
  return join(settingsDir(), "session-chains.json");
}

export function legacyTabsFileForBackend(backend: "api" | "cli"): string {
  return join(settingsDir(), `tabs-${backend}.json`);
}

export function legacySessionLabelsFileForBackend(
  backend: "api" | "cli",
): string {
  return join(settingsDir(), `session-labels-${backend}.json`);
}

export function legacySessionChainsFileForBackend(
  backend: "api" | "cli",
): string {
  return join(settingsDir(), `session-chains-${backend}.json`);
}

export function loadSessionLabels(): Record<string, string> {
  try {
    if (existsSync(sessionLabelsFile())) {
      return JSON.parse(readFileSync(sessionLabelsFile(), "utf-8"));
    }
  } catch (err) {
    log("settings_store: failed to load session labels", {
      error: String(err),
    });
  }
  return {};
}

export function saveSessionLabels(labels: Record<string, string>): void {
  try {
    if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true });
    atomicWriteFileSync(
      sessionLabelsFile(),
      JSON.stringify(labels, null, 2),
      0o644,
    );
  } catch (err) {
    log("settings_store: failed to save session labels", {
      error: String(err),
    });
  }
}

export function loadSessionChains(): {
  chains: Record<string, string[]>;
  reverse: Record<string, string>;
} {
  try {
    if (existsSync(sessionChainsFile())) {
      return JSON.parse(readFileSync(sessionChainsFile(), "utf-8"));
    }
  } catch (err) {
    log("settings_store: failed to load session chains", {
      error: String(err),
    });
  }
  return { chains: {}, reverse: {} };
}

export function saveSessionChains(data: {
  chains: Record<string, string[]>;
  reverse: Record<string, string>;
}): void {
  try {
    if (!existsSync(settingsDir())) mkdirSync(settingsDir(), { recursive: true });
    atomicWriteFileSync(
      sessionChainsFile(),
      JSON.stringify(data, null, 2),
      0o644,
    );
  } catch (err) {
    log("settings_store: failed to save session chains", {
      error: String(err),
    });
  }
}

/**
 * Read the gitWatcherIgnoredDirectories setting from disk, expand tilde and
 * $HOME, and return absolute paths. Falls back to the default ['~/.ion'] when
 * the key is absent or malformed.
 *
 * A stored empty array is honored as "watch everywhere" -- it is not overridden
 * with the default. Only a missing key or a non-array value triggers fallback.
 * Individual non-string items within a valid array are silently dropped.
 */
export function readGitWatcherIgnoredDirectories(): string[] {
  const raw = readSettings();
  const defaultList = SETTINGS_DEFAULTS.gitWatcherIgnoredDirectories;

  if (
    !Object.prototype.hasOwnProperty.call(raw, "gitWatcherIgnoredDirectories")
  ) {
    return defaultList.map(expandHome);
  }
  const stored = raw.gitWatcherIgnoredDirectories;
  if (!Array.isArray(stored)) {
    return defaultList.map(expandHome);
  }
  return (stored as unknown[])
    .filter((v): v is string => typeof v === "string")
    .map(expandHome);
}
