/**
 * Feature flag system.
 *
 * Three layers (highest priority wins):
 *   1. Environment variable: CODA_FLAG_{NAME}=1
 *   2. Settings file: ~/.coda/settings.json featureFlags.{name}
 *   3. Build-time defines: via electron-vite define config
 *
 * Usage:
 *   if (flags.get('remoteApi')) { ... }
 *   flags.set('remoteApi', true)  // persists to settings
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const SETTINGS_FILE = join(homedir(), '.coda', 'settings.json')

export interface FlagDefinition {
  name: string
  description: string
  defaultValue: boolean
}

const FLAG_DEFINITIONS: FlagDefinition[] = [
  { name: 'remoteApi', description: 'Enable remote control transport layer', defaultValue: false },
  { name: 'sdkMode', description: 'Use Agent SDK instead of CLI process spawning', defaultValue: false },
  { name: 'enhancedHooks', description: 'Enable extended hook event types (PostToolUse, SubagentStart, etc.)', defaultValue: false },
  { name: 'backgroundTasks', description: 'Enable background task framework', defaultValue: false },
  { name: 'multiAgent', description: 'Enable multi-agent tab communication', defaultValue: false },
]

class FeatureFlags {
  private overrides = new Map<string, boolean>()
  private settingsCache: Record<string, boolean> | null = null

  constructor() {
    this._loadFromSettings()
  }

  /** Get the effective value of a flag. */
  get(name: string): boolean {
    // Layer 1: Environment variable (highest priority).
    const envKey = `CODA_FLAG_${name.replace(/([A-Z])/g, '_$1').toUpperCase()}`
    const envVal = process.env[envKey]
    if (envVal === '1' || envVal === 'true') return true
    if (envVal === '0' || envVal === 'false') return false

    // Layer 2: Runtime overrides (from settings or programmatic set).
    if (this.overrides.has(name)) return this.overrides.get(name)!

    // Layer 3: Settings file.
    if (this.settingsCache && name in this.settingsCache) return this.settingsCache[name]

    // Layer 4: Default value from definition.
    const def = FLAG_DEFINITIONS.find((d) => d.name === name)
    return def?.defaultValue ?? false
  }

  /** Set a flag value (persisted to settings on next save). */
  set(name: string, value: boolean): void {
    this.overrides.set(name, value)
  }

  /** Get all flag values as a record. */
  getAll(): Record<string, boolean> {
    const result: Record<string, boolean> = {}
    for (const def of FLAG_DEFINITIONS) {
      result[def.name] = this.get(def.name)
    }
    return result
  }

  /** Get flag definitions for UI display. */
  getDefinitions(): FlagDefinition[] {
    return [...FLAG_DEFINITIONS]
  }

  /** Reload from settings file. */
  reload(): void {
    this._loadFromSettings()
  }

  private _loadFromSettings(): void {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const data = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
        if (data.featureFlags && typeof data.featureFlags === 'object') {
          this.settingsCache = data.featureFlags
        }
      }
    } catch {
      // Settings file unreadable, use defaults.
    }
  }
}

export const flags = new FeatureFlags()
