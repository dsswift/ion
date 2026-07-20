import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, warn as _warn } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { encryptSensitiveSettings, decryptSensitiveSettings } from './utils/secretStore'
import { expandHome } from './git/ignore-paths'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

export const SETTINGS_DIR = join(homedir(), '.ion')
export const SETTINGS_FILE = join(SETTINGS_DIR, 'settings.json')
export const ENGINE_CONFIG_FILE = join(SETTINGS_DIR, 'engine.json')

export const SETTINGS_DEFAULTS = {
  themeMode: 'dark',
  soundEnabled: true,
  expandedUI: false,
  ultraWide: false,
  defaultBaseDirectory: '',
  showDirLabel: true,
  preferredOpenWith: 'cli',
  expandToolResults: false,
  terminalFontFamily: 'Menlo, Monaco, monospace',
  terminalFontSize: 13,
  allowSettingsEdits: false,
  enableClaudeCompat: true,
  preferredModel: 'claude-opus-4-6',
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
  gitWatcherIgnoredDirectories: ['~/.ion'] as string[],
  // Global gate for extended thinking / reasoning. Default OFF — Ion is
  // API-billed, where thinking tokens bill as output tokens at full rate and
  // can multiply a turn's cost several-fold. When OFF, no prompt carries a
  // thinking directive and the per-conversation thinking control is hidden on
  // both clients. When ON, the per-conversation control appears and the
  // selected effort rides on each prompt. See StatusBarThinkingPicker.tsx and
  // the engine's resolveThinking helper.
  thinkingEnabled: false,
  // Agent Team Visualizer (desktop-only window; none of these keys are iOS
  // projectable). atvSeeds maps an extension scope (engineProfileId, or
  // 'local' for plain tabs) to a user-chosen office seed string.
  atvTheme: 'ion-works',
  atvPinned: false,
  // 0 = fit-to-window (default); 1..6 = manual integer zoom.
  atvZoom: 0,
  // One office seed for the whole desktop ('' = built-in default). The
  // office layout is the user's office — identical across conversations.
  atvSeed: '',
  // While the ATV window is open, flip the app's activation policy to
  // 'regular' so Ion appears in the Dock and Cmd-Tab (immersive-app
  // behavior); reverts to accessory when the window closes.
  atvDockPresence: true,
  // Which surface(s) appear at startup: 'overlay' | 'atv' | 'both'. The
  // overlay RENDERER always runs (it owns session state); this only governs
  // what the user sees first.
  launchSurface: 'overlay',
  // Global shortcut toggling the ATV shell (Electron accelerator; '' = none).
  atvShortcut: 'Alt+Shift+Space',
  // Footstep-heat overlay on the ATV canvas (traffic visualization).
  atvHeat: false,
  // ATV shell layout (dock open/width/tab) — one global state persisted
  // across opens and restarts, never per-session.
  atvLayout: { dockOpen: false, dockWidth: 420, dockTab: 'conversation' },
  // Ambient soundscape in the ATV (procedurally synthesized; mute toggle
  // in the control bar — office users need one-click silence).
  atvSound: true,
  // Dock bounce + title prefix when a permission arrives while the ATV is
  // open but unfocused.
  atvBeacon: true,
  // Beta gate for the Agent Team Visualizer. Default false — the ATV is
  // shipping as a beta feature that is intentionally not advertised. Set
  // to true in ~/.ion/settings.json to enable the launcher button, tray
  // item, global shortcut, and window. The ATV window itself cannot write
  // this key (it is not in ATV_SETTING_KEYS in ipc/atv.ts).
  atvBeta: false,
  // Auto-open the ATV side dock when the conversation awaits user input
  // (plan ready / question / permission).
  atvAutoDrawer: true,
  // Enterprise/operator surface gate: 'both' | 'overlay-only' | 'atv-only'.
  // Deployable via managed settings.json; clamps launchSurface and disables
  // the gated surface's launchers (tray item, button, shortcut, atv:open).
  surfacePolicy: 'both',
}

export function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
    return decryptSensitiveSettings(raw)
  } catch (err) {
    log('settings_store: failed to read settings', { error: String(err) })
    return {}
  }
}

export function writeSettings(data: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
  const encrypted = encryptSensitiveSettings(data)
  atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(encrypted, null, 2), 0o600)
  // Any settings write may have flipped a hot-path-cached projectable flag.
  // Invalidate the cache here, at the single write helper, so the next read
  // re-pulls from disk. Cheap (clears a primitive); correctness over saving
  // one disk read.
  invalidateStreamThinkingToRemoteCache()
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
let streamThinkingCache: boolean | null = null

/** Drop the cached `streamThinkingToRemote` value; next read re-pulls disk. */
export function invalidateStreamThinkingToRemoteCache(): void {
  streamThinkingCache = null
}

/**
 * Resolve `streamThinkingToRemote` from settings.json, cached for the hot
 * forward path. Defaults to `true` (stream ON) when the key is absent or
 * not a boolean — matching SETTINGS_DEFAULTS. The cache is invalidated by
 * `writeSettings` so a toggle change takes effect on the next delta.
 */
export function shouldStreamThinkingToRemote(): boolean {
  if (streamThinkingCache !== null) return streamThinkingCache
  const raw = readSettings()
  const v = raw.streamThinkingToRemote
  // Default ON: only an explicit `false` disables streaming.
  streamThinkingCache = v === false ? false : true
  return streamThinkingCache
}

/**
 * Resolve the global `thinkingEnabled` gate from settings.json. Defaults to
 * `false` (thinking OFF) when the key is absent or not a boolean — matching
 * SETTINGS_DEFAULTS. This is the hard gate: when false the renderer hides the
 * per-conversation thinking control and never sends `thinkingEffort` on a
 * prompt. Not hot-path (read at prompt-submit time, not per-delta), so no
 * cache is needed.
 */
export function shouldEnableThinking(): boolean {
  const raw = readSettings()
  return raw.thinkingEnabled === true
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
    const v = readSettings().enableClaudeCompat
    return typeof v === 'boolean' ? v : SETTINGS_DEFAULTS.enableClaudeCompat
  } catch {
    return SETTINGS_DEFAULTS.enableClaudeCompat
  }
}

export function readEngineConfig(): Record<string, any> {
  try {
    if (existsSync(ENGINE_CONFIG_FILE)) {
      return JSON.parse(readFileSync(ENGINE_CONFIG_FILE, 'utf-8'))
    }
  } catch (err) {
    // A corrupt engine.json silently yields empty config and downstream reads
    // defaults with no trace — log the failure.
    warn('settings: engine config read failed', { error: String(err) })
  }
  return {}
}

export function writeEngineConfig(config: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
  atomicWriteFileSync(ENGINE_CONFIG_FILE, JSON.stringify(config, null, 2), 0o644)
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
  const cfg = readEngineConfig()
  if (cfg.backend === 'hybrid') return false
  const previous = cfg.backend ?? '(unset)'
  cfg.backend = 'hybrid'
  writeEngineConfig(cfg)
  log('settings_store: engine backend set to hybrid', { previous })
  return true
}

/**
 * Unified tab/label/chain storage. One file each, independent of which
 * backend serves any given conversation — a credential or routing change can
 * never make tabs "disappear" by pointing the loader at a different file.
 * The legacy per-backend files below are read-only inputs to the one-time
 * merge migration (tab-backend-merge.ts) and to the cleanup guards during
 * the migration window; nothing writes them anymore.
 */
export const TABS_FILE = join(SETTINGS_DIR, 'tabs.json')
export const SESSION_LABELS_FILE = join(SETTINGS_DIR, 'session-labels.json')
export const SESSION_CHAINS_FILE = join(SETTINGS_DIR, 'session-chains.json')

export function legacyTabsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `tabs-${backend}.json`)
}

export function legacySessionLabelsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `session-labels-${backend}.json`)
}

export function legacySessionChainsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `session-chains-${backend}.json`)
}

export function loadSessionLabels(): Record<string, string> {
  try {
    if (existsSync(SESSION_LABELS_FILE)) {
      return JSON.parse(readFileSync(SESSION_LABELS_FILE, 'utf-8'))
    }
  } catch (err) {
    log('settings_store: failed to load session labels', { error: String(err) })
  }
  return {}
}

export function saveSessionLabels(labels: Record<string, string>): void {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    atomicWriteFileSync(SESSION_LABELS_FILE, JSON.stringify(labels, null, 2), 0o644)
  } catch (err) {
    log('settings_store: failed to save session labels', { error: String(err) })
  }
}

export function loadSessionChains(): { chains: Record<string, string[]>; reverse: Record<string, string> } {
  try {
    if (existsSync(SESSION_CHAINS_FILE)) {
      return JSON.parse(readFileSync(SESSION_CHAINS_FILE, 'utf-8'))
    }
  } catch (err) {
    log('settings_store: failed to load session chains', { error: String(err) })
  }
  return { chains: {}, reverse: {} }
}

export function saveSessionChains(data: { chains: Record<string, string[]>; reverse: Record<string, string> }): void {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    atomicWriteFileSync(SESSION_CHAINS_FILE, JSON.stringify(data, null, 2), 0o644)
  } catch (err) {
    log('settings_store: failed to save session chains', { error: String(err) })
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
  const raw = readSettings()
  const defaultList = SETTINGS_DEFAULTS.gitWatcherIgnoredDirectories

  if (!Object.prototype.hasOwnProperty.call(raw, 'gitWatcherIgnoredDirectories')) {
    return defaultList.map(expandHome)
  }
  const stored = raw.gitWatcherIgnoredDirectories
  if (!Array.isArray(stored)) {
    return defaultList.map(expandHome)
  }
  return (stored as unknown[]).filter((v): v is string => typeof v === 'string').map(expandHome)
}
