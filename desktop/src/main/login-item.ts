/**
 * login-item — whether the operating system opens Ion when the person signs
 * in. The `openAtLogin` device setting says so; this keeps the system's own
 * login-item record in step with it: at start-up, when the setting is
 * changed in Studio, and when another process (an `ion fleet` deploy)
 * changes it in the device settings file.
 *
 * Only a packaged app registers itself: a development build would register
 * the bare Electron binary.
 */
import { app } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { deviceSettingsFile, readDeviceSettings } from './device-settings'
import { log as _log, warn as _warn } from './logger'

const TAG = 'login-item'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** How long writes are let settle before the file is read: an atomic write is a create and a rename. */
const SETTLE_MS = 150

/** The part of Electron this module uses. Test seam. */
export interface LoginItemApp {
  isPackaged: boolean
  getLoginItemSettings(): { openAtLogin: boolean }
  setLoginItemSettings(settings: { openAtLogin: boolean }): void
}

/** What the setting says now, with any device policy seal applied. */
export function wantsOpenAtLogin(): boolean {
  return readDeviceSettings().openAtLogin === true
}

/**
 * Makes the system's login item match `wanted`. Returns what was done:
 * `set` when the record changed, `unchanged` when it already matched, and
 * `skipped` for a build that must not register itself or a system that
 * refused.
 */
export function applyOpenAtLogin(wanted: boolean, target: LoginItemApp = app): 'set' | 'unchanged' | 'skipped' {
  if (!target.isPackaged) {
    log('login item left alone: not a packaged app', { wanted })
    return 'skipped'
  }
  try {
    const current = target.getLoginItemSettings().openAtLogin
    if (current === wanted) {
      log('login item already matches the setting', { open_at_login: wanted })
      return 'unchanged'
    }
    target.setLoginItemSettings({ openAtLogin: wanted })
    log('login item changed', { open_at_login: wanted })
    return 'set'
  } catch (err) {
    warn('login item could not be changed', { wanted, error: String(err) })
    return 'skipped'
  }
}

let watcher: FSWatcher | null = null
let timer: ReturnType<typeof setTimeout> | null = null

/** Applies the setting now, and again whenever the device settings file changes. Returns the stop function. */
export function startLoginItem(target: LoginItemApp = app): () => void {
  stopLoginItem()
  let last = wantsOpenAtLogin()
  applyOpenAtLogin(last, target)
  const file = deviceSettingsFile()
  const check = (): void => {
    timer = null
    if (!existsSync(file)) return
    const now = wantsOpenAtLogin()
    if (now === last) return
    last = now
    log('open at login changed in the device settings file', { open_at_login: now })
    applyOpenAtLogin(now, target)
  }
  try {
    // The directory, not the file: an atomic write replaces the file, which ends a watch on the file itself.
    watcher = watch(dirname(file), (_event, name) => {
      if (name !== null && name !== basename(file)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(check, SETTLE_MS)
    })
    watcher.on('error', (err) => warn('login item watch error', { file, error: String(err) }))
  } catch (err) {
    warn('login item watch could not start; the setting applies at the next launch', { file, error: String(err) })
  }
  return stopLoginItem
}

export function stopLoginItem(): void {
  if (timer) clearTimeout(timer)
  timer = null
  watcher?.close()
  watcher = null
}
