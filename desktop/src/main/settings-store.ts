import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { encryptSensitiveSettings, decryptSensitiveSettings } from './utils/secretStore'
import { expandHome } from './git/ignore-paths'

function log(msg: string): void {
  _log('main', msg)
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
  // button reveal and usePermissionDeniedHandlers.ts::onImplement for
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
}

export function readSettings(): Record<string, any> {
  if (!existsSync(SETTINGS_FILE)) return {}
  try {
    const raw = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
    return decryptSensitiveSettings(raw)
  } catch (err) {
    log(`Failed to read settings: ${err}`)
    return {}
  }
}

export function writeSettings(data: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
  const encrypted = encryptSensitiveSettings(data)
  atomicWriteFileSync(SETTINGS_FILE, JSON.stringify(encrypted, null, 2), 0o600)
}

export function readEngineConfig(): Record<string, any> {
  try {
    if (existsSync(ENGINE_CONFIG_FILE)) {
      return JSON.parse(readFileSync(ENGINE_CONFIG_FILE, 'utf-8'))
    }
  } catch {}
  return {}
}

export function writeEngineConfig(config: Record<string, any>): void {
  if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
  atomicWriteFileSync(ENGINE_CONFIG_FILE, JSON.stringify(config, null, 2), 0o644)
}

export function getCurrentBackend(): 'api' | 'cli' {
  const cfg = readEngineConfig()
  return cfg.backend === 'api' ? 'api' : 'cli'
}

export const currentBackend = getCurrentBackend()

export function tabsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `tabs-${backend}.json`)
}

export function sessionLabelsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `session-labels-${backend}.json`)
}

export function sessionChainsFileForBackend(backend: 'api' | 'cli'): string {
  return join(SETTINGS_DIR, `session-chains-${backend}.json`)
}

export const TABS_FILE = tabsFileForBackend(currentBackend)
export const SESSION_LABELS_FILE = sessionLabelsFileForBackend(currentBackend)
export const SESSION_CHAINS_FILE = sessionChainsFileForBackend(currentBackend)

export function loadSessionLabels(): Record<string, string> {
  try {
    if (existsSync(SESSION_LABELS_FILE)) {
      return JSON.parse(readFileSync(SESSION_LABELS_FILE, 'utf-8'))
    }
  } catch (err) {
    log(`Failed to load session labels: ${err}`)
  }
  return {}
}

export function saveSessionLabels(labels: Record<string, string>): void {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    atomicWriteFileSync(SESSION_LABELS_FILE, JSON.stringify(labels, null, 2), 0o644)
  } catch (err) {
    log(`Failed to save session labels: ${err}`)
  }
}

export function loadSessionChains(): { chains: Record<string, string[]>; reverse: Record<string, string> } {
  try {
    if (existsSync(SESSION_CHAINS_FILE)) {
      return JSON.parse(readFileSync(SESSION_CHAINS_FILE, 'utf-8'))
    }
  } catch (err) {
    log(`Failed to load session chains: ${err}`)
  }
  return { chains: {}, reverse: {} }
}

export function saveSessionChains(data: { chains: Record<string, string[]>; reverse: Record<string, string> }): void {
  try {
    if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
    atomicWriteFileSync(SESSION_CHAINS_FILE, JSON.stringify(data, null, 2), 0o644)
  } catch (err) {
    log(`Failed to save session chains: ${err}`)
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
