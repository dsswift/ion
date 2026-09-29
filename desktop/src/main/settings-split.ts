/**
 * settings-split — the one-time migration that partitions the legacy
 * `settings.json` into `desktop.json` (device keys) and a trimmed
 * `settings.json` (server keys), per spec 12 §Functional "Settings split" and
 * §Edge Cases.
 *
 * Migration precedent: `tab-migration-unify-runner.ts` (backup first, verify
 * before declaring success, never silently drop data). Runs BEFORE the local
 * server spawns, so the server never observes a `settings.json` that still
 * carries device keys.
 */
import { existsSync, copyFileSync, readFileSync, unlinkSync } from 'fs'
import { settingsFile, readSettings, writeSettings } from '@ion/server/persistence/settings-store'
import { settingScope } from '@ion/shared/settings-registry'
import { atomicWriteFileSync } from '@ion/server/utils/atomicWrite'
import { DEVICE_KEYS, deviceSettingsFile, readDeviceSettings, writeDeviceSettings } from './device-settings'
import { log as _log, warn as _warn, error as _error } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('settings-split', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('settings-split', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('settings-split', msg, fields)
}

/** Legacy keys deleted outright on split (baseline.md §3 "Deleted"). Never moved to desktop.json. */
export const LEGACY_SETTINGS_KEYS = ['activeUi', 'activeUiPolicy', 'surfacePolicy', 'launchSurface'] as const

export function preSplitBackupFile(): string {
  return `${settingsFile()}.pre-split.bak`
}

export interface SettingsSplitOutcome {
  ran: boolean
  reason: 'already-split' | 'no-settings-file' | 'success' | 'verify-failed' | 'error'
  movedKeys?: string[]
  strippedLegacyKeys?: string[]
  errorMessage?: string
}

function stripKeys(settings: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out = { ...settings }
  for (const key of keys) delete out[key]
  return out
}

/**
 * Verifies every device key round-tripped byte-for-byte (JSON-equal) between
 * the legacy settings blob and what was actually written to `desktop.json`.
 * Returns null on success, or the first mismatched key on failure.
 */
function verifyRoundTrip(legacy: Record<string, unknown>, movedKeys: string[]): string | null {
  const written = readDeviceSettings()
  for (const key of movedKeys) {
    if (JSON.stringify(legacy[key]) !== JSON.stringify(written[key])) {
      return key
    }
  }
  return null
}

/**
 * Runs the split exactly once. A no-op (Edge Cases §1's "settings.json still
 * has device keys" case is handled separately by `stripStaleDeviceKeys`,
 * below — this function only runs the FIRST-TIME partition).
 */
export function runSettingsSplit(): SettingsSplitOutcome {
  if (existsSync(deviceSettingsFile())) {
    log('runSettingsSplit: desktop.json already present; no-op')
    return { ran: false, reason: 'already-split' }
  }
  if (!existsSync(settingsFile())) {
    log('runSettingsSplit: no settings.json to split; nothing to do')
    return { ran: false, reason: 'no-settings-file' }
  }

  const backupPath = preSplitBackupFile()
  try {
    copyFileSync(settingsFile(), backupPath)
    log('runSettingsSplit: backed up settings.json', { backup: backupPath })
  } catch (err) {
    error('runSettingsSplit: backup failed', { error: (err as Error).message })
    return { ran: false, reason: 'error', errorMessage: `backup failed: ${(err as Error).message}` }
  }

  const legacy = readSettings()
  const device: Record<string, unknown> = {}
  const movedKeys: string[] = []
  for (const key of DEVICE_KEYS) {
    if (key in legacy) {
      device[key] = legacy[key]
      movedKeys.push(key)
    }
  }

  try {
    writeDeviceSettings(device)
  } catch (err) {
    error('runSettingsSplit: writing desktop.json failed', { error: (err as Error).message })
    return { ran: false, reason: 'error', backupPath, errorMessage: (err as Error).message } as SettingsSplitOutcome
  }

  const problem = verifyRoundTrip(legacy, movedKeys)
  if (problem) {
    error('runSettingsSplit: verify failed; leaving settings.json untouched', { key: problem })
    return { ran: false, reason: 'verify-failed', movedKeys, errorMessage: `key '${problem}' did not round-trip` }
  }

  const strippedLegacyKeys = LEGACY_SETTINGS_KEYS.filter((k) => k in legacy)
  const trimmed = stripKeys(stripKeys(legacy, DEVICE_KEYS), LEGACY_SETTINGS_KEYS)
  writeSettings(trimmed)

  for (const key of movedKeys) log('runSettingsSplit: moved device key', { key })
  for (const key of strippedLegacyKeys) log('runSettingsSplit: dropped legacy key', { key })
  log('runSettingsSplit: split complete', {
    moved_count: movedKeys.length,
    legacy_dropped_count: strippedLegacyKeys.length,
    backup: backupPath,
  })
  return { ran: true, reason: 'success', movedKeys, strippedLegacyKeys: [...strippedLegacyKeys] }
}

/**
 * Edge Cases §1: an older desktop build (pre-split binary, or one that wrote
 * a device key via a stale code path) re-adds device keys to `settings.json`
 * after the split already ran. Runs on every boot, after `runSettingsSplit`,
 * so `settings.json` never accumulates device keys again. No-op when nothing
 * is stale.
 */
export function stripStaleDeviceKeys(): string[] {
  if (!existsSync(settingsFile())) return []
  const settings = readSettings()
  const stale = [...DEVICE_KEYS, ...LEGACY_SETTINGS_KEYS].filter((k) => k in settings)
  if (stale.length === 0) return []
  warn('stripStaleDeviceKeys: settings.json regained device/legacy keys; stripping again', { keys: stale })
  const cleaned = stripKeys(stripKeys(settings, DEVICE_KEYS), LEGACY_SETTINGS_KEYS)
  writeSettings(cleaned)
  return stale
}

/**
 * Returns server settings stranded in `desktop.json` to `settings.json`.
 *
 * The device key list once named `defaultBaseDirectory` (an Account setting)
 * and `studioPlaywrightEnabled` (an Environment setting). The split moved
 * both out of `settings.json`, and `stripStaleDeviceKeys` deleted them again
 * on every launch, so the server read its defaults: a conversation opened
 * with no directory landed in the home folder, and turning the browser tools
 * off lasted until the next launch. The server is the only reader of either.
 *
 * Any key the registry scopes to a server comes out of `desktop.json`. Its
 * value goes back to `settings.json` when the server has none; when the
 * server already holds one, the server's wins and the device copy is dropped.
 * A no-op once `desktop.json` holds no server key.
 */
export function returnStrandedServerKeys(): { restored: string[]; discarded: string[] } {
  const file = deviceSettingsFile()
  if (!existsSync(file)) return { restored: [], discarded: [] }
  let device: Record<string, unknown>
  try {
    device = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    warn('returnStrandedServerKeys: desktop.json unreadable; nothing returned', { error: (err as Error).message })
    return { restored: [], discarded: [] }
  }
  const stranded = Object.keys(device).filter((key) => {
    const scope = settingScope(key)
    return scope === 'environment' || scope === 'account'
  })
  if (stranded.length === 0) return { restored: [], discarded: [] }
  const settings = readSettings()
  const restored: string[] = []
  const discarded: string[] = []
  for (const key of stranded) {
    if (key in settings) discarded.push(key)
    else {
      settings[key] = device[key]
      restored.push(key)
    }
    delete device[key]
  }
  if (restored.length > 0) writeSettings(settings)
  writeDeviceSettings(device)
  log('returnStrandedServerKeys: server settings moved out of desktop.json', { restored, discarded })
  return { restored, discarded }
}

/**
 * Edge Cases §2 (rollback, tested): restores `settings.json` from its
 * pre-split backup and deletes `desktop.json`, returning a pre-split desktop
 * to its original state. Manual/test operation — never called at boot.
 */
export function rollbackSettingsSplit(): { restored: boolean; reason: 'no-backup' | 'success' } {
  const backupPath = preSplitBackupFile()
  if (!existsSync(backupPath)) {
    warn('rollbackSettingsSplit: no backup file present; nothing to restore')
    return { restored: false, reason: 'no-backup' }
  }
  const original = readFileSync(backupPath, 'utf-8')
  atomicWriteFileSync(settingsFile(), original, 0o600)
  const deviceFile = deviceSettingsFile()
  if (existsSync(deviceFile)) {
    unlinkSync(deviceFile)
    log('rollbackSettingsSplit: removed desktop.json', { file: deviceFile })
  }
  log('rollbackSettingsSplit: restored settings.json from pre-split backup', { backup: backupPath })
  return { restored: true, reason: 'success' }
}
