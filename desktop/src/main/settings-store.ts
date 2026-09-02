import { existsSync, mkdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log as _log, warn as _warn } from "./logger";
import { atomicWriteFileSync } from "./utils/atomicWrite";
import {
  encryptSensitiveSettings,
  decryptSensitiveSettings,
} from "./utils/secretStore";
import { expandHome } from "./git/ignore-paths";
import type { ThinkingConfig } from "../shared/types-engine";
import type { ThinkingEffort } from "../shared/types-session";
import { isThinkingEffort } from "../shared/thinking-options";

function log(msg: string, fields?: Record<string, unknown>): void {
  _log("main", msg, fields);
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn("main", msg, fields);
}

export const SETTINGS_DIR = join(homedir(), ".ion");
export const SETTINGS_FILE = join(SETTINGS_DIR, "settings.json");
export const ENGINE_CONFIG_FILE = join(SETTINGS_DIR, "engine.json");

export const SETTINGS_DEFAULTS = {
  /**
   * Minimum desktop log level written to ~/.ion/desktop.jsonl.
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
  expandedUI: false,
  ultraWide: false,
  defaultBaseDirectory: "",
  showDirLabel: true,
  preferredOpenWith: "cli",
  expandToolResults: false,
  terminalFontFamily: "Menlo, Monaco, monospace",
  terminalFontSize: 13,
  allowSettingsEdits: false,
  // Claude Code compatibility is a migration feature, not a default: .claude
  // roots (commands, skills, CLAUDE.md context) load only when the user
  // explicitly enables it. Greenfield installs are .ion-only.
  enableClaudeCompat: false,
  preferredModel: "claude-opus-4-6",
  // Early-stop continuation nudge: when the model emits end_turn below the
  // configured output-token target, ask it to keep working. Default OFF per
  // ADR-002 2026-05-25 amendment (the feature is opt-in; users who want the
  // nudge enable it in General settings or via the Remote settings row).
  // See desktop/src/main/early-stop-policy.ts for the policy that consumes
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
  // Studio can hide its conversation Tab Strip without changing the selected
  // left-dock view. The Overlay always keeps its compact Tab Strip.
  studioTabStripVisible: true,
  // Project registry (G1): known base dirs, auto-populated from
  // conversation tabs + manual adds. Machine-local paths — never
  // projectable (iOS derives chips from tab workingDirectory).
  projects: {} as Record<string, { name?: string; addedManually: boolean; lastUsedAt: number }>,
  // Per-conversation thinking effort default. 'high' is the desktop's
  // opinionated default; users can override in Settings. Per-conversation
  // changes live on the instance (StatusBarThinkingPicker).
  defaultThinkingEffort: "high" as ThinkingEffort,
  // Ion Studio (desktop-only window; none of these keys are iOS
  // projectable). studioSeeds maps an extension scope (engineProfileId, or
  // 'local' for plain tabs) to a user-chosen office seed string.
  studioTheme: "ion-works",
  // 0 = fit-to-window (default); 1..6 = manual integer zoom.
  studioZoom: 0,
  // One office seed for the whole desktop ('' = built-in default). The
  // office layout is the user's office — identical across conversations.
  studioSeed: "",
  // While the Studio window is open, flip the app's activation policy to
  // 'regular' so Ion appears in the Dock and Cmd-Tab (immersive-app
  // behavior); reverts to accessory when the window closes.
  studioDockPresence: true,
  // Which conversation UI is active: 'overlay' | 'studio'. Single-UI
  // exclusivity: exactly one at a time (never both). The overlay RENDERER
  // always runs (it owns session state); this governs which UI the user
  // sees and which launchers/shortcuts exist.
  activeUi: "overlay",
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
  // Ambient soundscape in the Studio window (procedurally synthesized; mute toggle
  // in the control bar — office users need one-click silence).
  studioSound: true,
  // Dock bounce + title prefix when a permission arrives while the Studio window is
  // open but unfocused.
  studioBeacon: true,
  // LEGACY enterprise/operator surface gate: 'both' | 'overlay-only' |
  // 'atv-only'. The boot migration folds this into activeUi and drops the
  // key; the resolver still honors it for a managed settings.json pushed
  // mid-cycle. The Active UI workstream replaces it with the MDM
  // activeUiPolicy blob and retires this key entirely.
  surfacePolicy: "both",
};

export function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    return decryptSensitiveSettings(raw);
  } catch (err) {
    log("settings_store: failed to read settings", { error: String(err) });
    return {};
  }
}

export function writeSettings(data: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
  const encrypted = encryptSensitiveSettings(data);
  atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(encrypted, null, 2), 0o600);
  // Any settings write may have flipped a hot-path-cached projectable flag.
  // Invalidate the cache here, at the single write helper, so the next read
  // re-pulls from disk. Cheap (clears a primitive); correctness over saving
  // one disk read.
  invalidateStreamThinkingToRemoteCache();
}

// ─── streamThinkingToRemote hot-path cache (issue #158) ───
//
// `streamThinkingToRemote` (default true) gates whether the desktop forwards
// `engine_thinking_delta` events to paired iOS devices. That gate is read on
// the iOS forward path in event-wiring.ts, which can fire many times per
// second during an extended-thinking turn. Re-reading settings.json from disk
// on every delta would be wasteful, so we cache the resolved boolean and
// invalidate it on every settings write (the single funnel above) — settings
// changes are infrequent, deltas are not.
let streamThinkingCache: boolean | null = null;

/** Drop the cached `streamThinkingToRemote` value; next read re-pulls disk. */
export function invalidateStreamThinkingToRemoteCache(): void {
  streamThinkingCache = null;
}

/**
 * Resolve `streamThinkingToRemote` from settings.json, cached for the hot
 * forward path. Defaults to `true` (stream ON) when the key is absent or
 * not a boolean — matching SETTINGS_DEFAULTS. The cache is invalidated by
 * `writeSettings` so a toggle change takes effect on the next delta.
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
 * Resolve the user's default per-conversation thinking effort from
 * settings.json. This is the level a NEW conversation starts at; the user can
 * still change any individual conversation with the status-bar picker.
 *
 * Defaults to 'high' when absent or not one of the four valid levels, matching
 * SETTINGS_DEFAULTS. 'high' is the desktop's opinionated default.
 */
export function readDefaultThinkingEffort(): ThinkingEffort {
  const raw = readSettings();
  const v = raw.defaultThinkingEffort;
  // 'adaptive' is deliberately NOT accepted here: this preference seeds
  // effort-based models, and adaptive models derive their own default from
  // capability metadata (see defaultEffortForMode). A hand-edited 'adaptive'
  // would otherwise be sent to a model that cannot use it.
  if (isThinkingEffort(v) && v !== "adaptive") return v;
  return "high";
}

/**
 * Resolve the per-session thinking config the desktop hands the engine on
 * `start_session` (`EngineConfig.thinking`).
 *
 * Returns `undefined` when the global gate is off, which is deliberate rather
 * than a `{enabled:false}` block: an omitted field leaves the engine's own
 * `engine.json` default in play for anything that is not this desktop's
 * conversation, whereas the per-prompt `thinkingEffort` the renderer sends on
 * every submit is what actually decides each run. The session default exists
 * so a run dispatched WITHOUT a per-prompt effort — an extension's
 * `ctx.sendPrompt`, a scheduled job, a resumed session's first engine-side
 * turn — still reflects the user's setting instead of silently falling back
 * to the host-wide default.
 *
 * `streamDeltas` is deliberately left UNSET so the engine's default-ON
 * emission stands. It is tempting to wire it to the `streamThinkingToRemote`
 * preference, but the two gate different hops: `streamDeltas` suppresses the
 * engine's per-token emission on the engine socket itself
 * (`runloop_stream.go`), which is the feed the desktop's OWN thinking display
 * renders from, whereas `streamThinkingToRemote` drops the delta only at the
 * desktop→iOS forward path (`event-wiring.ts`). Wiring them together would
 * mean a user trimming phone bandwidth silently loses live thinking on their
 * desktop.
 */
export function resolveSessionThinkingConfig(): ThinkingConfig | undefined {
  const effort = readDefaultThinkingEffort();
  if (effort === "off") {
    log(
      "thinking config: enabled but default level off, omitting session default",
    );
    return undefined;
  }
  const cfg: ThinkingConfig = { enabled: true, effort };
  log("thinking config: resolved session default", { reason: effort });
  return cfg;
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
    if (existsSync(ENGINE_CONFIG_FILE)) {
      return JSON.parse(readFileSync(ENGINE_CONFIG_FILE, "utf-8"));
    }
  } catch (err) {
    // A corrupt engine.json silently yields empty config and downstream reads
    // defaults with no trace — log the failure.
    warn("settings: engine config read failed", { error: String(err) });
  }
  return {};
}

export function writeEngineConfig(config: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
  atomicWriteFileSync(
    ENGINE_CONFIG_FILE,
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
export const TABS_FILE = join(SETTINGS_DIR, "tabs.json");
export const SESSION_LABELS_FILE = join(SETTINGS_DIR, "session-labels.json");
export const SESSION_CHAINS_FILE = join(SETTINGS_DIR, "session-chains.json");

export function legacyTabsFileForBackend(backend: "api" | "cli"): string {
  return join(SETTINGS_DIR, `tabs-${backend}.json`);
}

export function legacySessionLabelsFileForBackend(
  backend: "api" | "cli",
): string {
  return join(SETTINGS_DIR, `session-labels-${backend}.json`);
}

export function legacySessionChainsFileForBackend(
  backend: "api" | "cli",
): string {
  return join(SETTINGS_DIR, `session-chains-${backend}.json`);
}

export function loadSessionLabels(): Record<string, string> {
  try {
    if (existsSync(SESSION_LABELS_FILE)) {
      return JSON.parse(readFileSync(SESSION_LABELS_FILE, "utf-8"));
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
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    atomicWriteFileSync(
      SESSION_LABELS_FILE,
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
    if (existsSync(SESSION_CHAINS_FILE)) {
      return JSON.parse(readFileSync(SESSION_CHAINS_FILE, "utf-8"));
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
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true });
    atomicWriteFileSync(
      SESSION_CHAINS_FILE,
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
