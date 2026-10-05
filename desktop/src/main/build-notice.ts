/**
 * The Build Notice's main-process half: knows the running build (stamped by
 * `electron.vite.config.ts`), remembers the build this device last
 * acknowledged in `desktop.json`, and answers the Studio window's two calls.
 *
 * Only a packaged app has a notice: `npm run dev` rebuilds on every restart
 * and is never installed. The `showBuildNotice` device setting turns it off,
 * and device policy can seal that setting either way.
 */
import { app, ipcMain } from 'electron'
import { IPC } from '@ion/shared/types'
import { buildNoticeFor, parseDesktopBuild, type BuildNotice, type DesktopBuild } from '@ion/shared/build-notice'
import { readDeviceSettings, readStoredDeviceSettings, updateDeviceSetting } from './device-settings'
import { log as _log, warn as _warn } from './logger'

declare const __ION_DESKTOP_VERSION__: string
declare const __ION_DESKTOP_BUILT_AT__: string
declare const __ION_DESKTOP_WHATS_NEW__: string[]

/** The device-local record of the last acknowledged build. App-written, not a setting. */
const ACKNOWLEDGED_BUILD_KEY = 'acknowledgedDesktopBuild'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('build-notice', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('build-notice', msg, fields)
}

function runningBuild(): DesktopBuild {
  return { version: __ION_DESKTOP_VERSION__, builtAt: __ION_DESKTOP_BUILT_AT__ }
}

export function currentBuildNotice(): BuildNotice | null {
  const current = runningBuild()
  if (!app.isPackaged) {
    log('no build notice: app is not packaged', { version: current.version })
    return null
  }
  const acknowledged = parseDesktopBuild(readStoredDeviceSettings()[ACKNOWLEDGED_BUILD_KEY])
  const notice = buildNoticeFor(current, acknowledged, __ION_DESKTOP_WHATS_NEW__)
  // The setting in force, under device policy. Off records the build as seen,
  // so turning it back on shows the next update rather than this one.
  if (notice && readDeviceSettings().showBuildNotice === false) {
    log('no build notice: turned off by the showBuildNotice setting; recording the build as seen', { version: current.version, built_at: current.builtAt })
    acknowledgeBuild()
    return null
  }
  log(notice ? 'build notice due' : 'no build notice: build already acknowledged', {
    version: current.version,
    built_at: current.builtAt,
    previous_version: acknowledged?.version ?? null,
    previous_built_at: acknowledged?.builtAt ?? null,
    highlights: __ION_DESKTOP_WHATS_NEW__.length,
  })
  return notice
}

export function acknowledgeBuild(): void {
  const current = runningBuild()
  try {
    updateDeviceSetting(ACKNOWLEDGED_BUILD_KEY, current)
    log('build acknowledged', { version: current.version, built_at: current.builtAt })
  } catch (err) {
    warn('build acknowledgement not saved; the notice shows again next launch', { version: current.version, error: String(err) })
  }
}

export function registerBuildNoticeIpc(): void {
  ipcMain.handle(IPC.BUILD_NOTICE_GET, () => currentBuildNotice())
  ipcMain.handle(IPC.BUILD_NOTICE_ACKNOWLEDGE, () => acknowledgeBuild())
}
