/**
 * device-settings — the `desktop.json` store (spec 12 §Functional "desktop.json
 * store"): the device-local half of what used to be `settings.json`. Same
 * atomic write discipline as `server/src/persistence/settings-store.ts`
 * (`settings-split.ts` is the one-time migration that populates this file
 * from a pre-split `settings.json`).
 *
 * The renderer never reads this file directly — it goes through the host
 * (`host.deviceSettings()`), per spec: "not through the wire". This module is
 * main-process only.
 */
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { dataDir } from '@ion/server/paths'
import { join } from 'path'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import type { EnvironmentTarget, EnvironmentViewFilter } from '@ion/shared/types-environments'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('device-settings', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('device-settings', msg, fields)
}

export function deviceSettingsFile(): string {
  return join(dataDir(), 'desktop.json')
}

/**
 * The device-key defaults, exactly as `SETTINGS_DEFAULTS` (`server/src/
 * persistence/settings-store.ts`) defined them before the split — kept here
 * so a machine with no `desktop.json` yet (a fresh install, or one that never
 * had a pre-split `settings.json`) still resolves every device key to its
 * historical default.
 */
export const DEVICE_SETTINGS_DEFAULTS = {
  logLevel: 'DEBUG',
  selectedTheme: 'ion-dark',
  soundEnabled: true,
  showDirLabel: true,
  preferredOpenWith: 'cli',
  expandToolResults: false,
  terminalFontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", Consolas, monospace',
  terminalFontSize: 13,
  showHiddenFiles: false,
  studioTheme: 'ion-works',
  studioZoom: 0,
  studioSeed: '',
  studioHeat: false,
  studioBeacon: true,
  studioSound: true,
  studioLayout: {
    leftSidebarVisible: false,
    leftSidebarView: 'explorer',
    surfaceWidth: 520,
    terminalHeight: 240,
    dispatchSplitRatio: 0.45,
  },
  studioSurface: { version: 4, pinnedTabs: ['plan'], notification: null, conversations: {}, scratchProjects: {} },
  studioComposerStash: { version: 1, projects: {} },
  studioShortcut: 'Alt+Shift+Space',
  // Spec 13 (manifest C10): the catalog of non-local environments this
  // device knows about, plus which one the Inbox is filtered
  // to. The always-present local environment is never an entry here.
  environments: [] as EnvironmentTarget[],
  environmentViewFilter: 'all' as EnvironmentViewFilter,
  // Idle-repaint warning limits (main/device-metrics/idle-repaint.ts): a GPU
  // helper or renderer above either percentage for this many seconds while
  // Studio is unfocused or the machine is idle logs a WARN.
  idleRepaintGpuPercent: 10,
  idleRepaintCpuPercent: 15,
  idleRepaintSeconds: 60,
} as const

/** The exact key set that lives in `desktop.json` (baseline.md §3 "Device"). */
export const DEVICE_KEYS: ReadonlyArray<keyof typeof DEVICE_SETTINGS_DEFAULTS> = Object.keys(
  DEVICE_SETTINGS_DEFAULTS,
) as Array<keyof typeof DEVICE_SETTINGS_DEFAULTS>

export function readDeviceSettings(): Record<string, unknown> {
  const file = deviceSettingsFile()
  if (!existsSync(file)) {
    log('readDeviceSettings: no desktop.json yet; returning defaults', { file })
    return { ...DEVICE_SETTINGS_DEFAULTS }
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return { ...DEVICE_SETTINGS_DEFAULTS, ...raw }
  } catch (err) {
    warn('readDeviceSettings: desktop.json unreadable; falling back to defaults', { file, error: (err as Error).message })
    return { ...DEVICE_SETTINGS_DEFAULTS }
  }
}

/**
 * This desktop's stable id for pairings: minted once, kept in the device
 * settings, sent with every pair request so a server keeps ONE record per
 * desktop however many times it is paired (`server/src/auth/credentials-store.ts`).
 */
export function deviceId(): string {
  const settings = readDeviceSettings()
  const existing = settings.deviceId
  if (typeof existing === 'string' && existing.length > 0) return existing
  const minted = randomUUID()
  updateDeviceSetting('deviceId', minted)
  log('device id minted', { device_id: minted })
  return minted
}

export function writeDeviceSettings(data: Record<string, unknown>): void {
  const file = deviceSettingsFile()
  const dir = dataDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(file, JSON.stringify(data, null, 2), 0o644)
  log('writeDeviceSettings: wrote desktop.json', { file, keys: Object.keys(data).length })
}

export function updateDeviceSetting(key: string, value: unknown): void {
  const current = readDeviceSettings()
  current[key] = value
  writeDeviceSettings(current)
  log('updateDeviceSetting: wrote one key', { key })
}
