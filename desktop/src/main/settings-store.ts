import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { encryptSensitiveSettings, decryptSensitiveSettings, isSafeStorageReady } from './utils/secretStore'

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
  showImplementClearContext: false,
  expandToolResults: false,
  terminalFontFamily: 'Menlo, Monaco, monospace',
  terminalFontSize: 13,
  allowSettingsEdits: false,
  enableClaudeCompat: true,
  preferredModel: 'claude-opus-4-6',
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
  if (!isSafeStorageReady()) {
    log('[Settings] safeStorage unavailable; secrets stored in plaintext (mode 0600)')
  }
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
