/**
 * settings-scope-migration — moves values to where the settings registry says
 * they live, once per data dir.
 *
 * Before the registry, the only Environment settings were the device
 * transport keys. Everything else a client saved went to the saver's overlay,
 * including settings that are really one value for the whole server
 * (auto-settle, conversation recovery, projects, engine profiles). Overlay
 * reads now drop Environment keys, so without this step those values would
 * silently fall back to whatever the shared document holds.
 *
 * What it does: every Environment key found in the LOCAL ACCOUNT's overlay is
 * promoted into the shared document, the overlay value winning, and removed
 * from that overlay. The local account is the one that matters because it is
 * the identity every timer-driven reader resolved to (`effectiveSubject`
 * with no request in context): the value promoted is the value the server
 * was already acting on, so behaviour is identical before and after. In
 * particular auto-settle cannot switch on anywhere it was off.
 *
 * Another person's overlay may also hold Environment keys. Those were never
 * what the server acted on, so they are not promoted; they are reported, and
 * left in place where overlay reads ignore them.
 *
 * Both files are backed up beside themselves (`<file>.pre-scope.bak`) before
 * anything is written, and a marker makes a second boot a no-op.
 */
import { copyFileSync, existsSync } from 'fs'
import { join } from 'path'
import { settingScope } from '@ion/shared/settings-registry'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { readSettings, writeSettings } from './settings-store'
import { listOverlays, overlayFilePath, replaceOverlay } from './user-settings-store'
import { log as _log, warn as _warn, error as _error } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('settings-scope-migration', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('settings-scope-migration', msg, fields) }
function error(msg: string, fields?: Record<string, unknown>): void { _error('settings-scope-migration', msg, fields) }

export const SETTINGS_SCOPE_MARKER_FILENAME = '.settings-scope-v1'

function backup(path: string): void {
  if (!existsSync(path)) return
  const target = `${path}.pre-scope.bak`
  if (existsSync(target)) return // an earlier, interrupted run already kept the original
  copyFileSync(path, target)
  log('backed up', { path, backup: target })
}

export interface SettingsScopeMigrationResult {
  ran: boolean
  promoted: string[]
}

export function runSettingsScopeMigration(localSubject: string, dir: string = dataDir()): SettingsScopeMigrationResult {
  const markerPath = join(dir, SETTINGS_SCOPE_MARKER_FILENAME)
  if (existsSync(markerPath)) {
    log('marker present; skipping')
    return { ran: false, promoted: [] }
  }

  const promoted: string[] = []
  try {
    for (const overlay of listOverlays()) {
      const environmentKeys = Object.keys(overlay.settings).filter((key) => settingScope(key) === 'environment')
      if (environmentKeys.length === 0) continue
      if (overlay.subject !== localSubject) {
        warn('another identity holds environment settings in its overlay; not promoted, and no longer read', { subject: overlay.subject, keys: environmentKeys })
        continue
      }
      const settingsPath = join(dir, 'settings.json')
      backup(settingsPath)
      backup(overlayFilePath(overlay.subject))
      const shared = readSettings()
      const remaining: Record<string, unknown> = { ...overlay.settings }
      for (const key of environmentKeys) {
        const differs = JSON.stringify(shared[key]) !== JSON.stringify(overlay.settings[key])
        log('promoting environment setting from the local overlay', { key, replaces_shared_value: differs && key in shared })
        shared[key] = overlay.settings[key]
        delete remaining[key]
        promoted.push(key)
      }
      // The shared document first: if the overlay rewrite then fails, the
      // value exists in both places and the overlay copy is simply ignored.
      writeSettings(shared)
      replaceOverlay(overlay.subject, remaining)
    }
  } catch (err) {
    // No marker: the next boot tries again. The backups stay.
    error('migration failed; will re-run on next boot', { error: String(err) })
    return { ran: true, promoted }
  }

  try {
    atomicWriteFileSync(markerPath, new Date().toISOString() + '\n', 0o644)
    log('migration complete', { promoted })
  } catch (err) {
    error('marker write failed; migration will re-run on next boot', { error: String(err) })
  }
  return { ran: true, promoted }
}
