/**
 * window-all-closed handler: Ion is tray-resident, so closing every window
 * (Overlay glass hidden, Studio window closed) must not quit the app when a
 * tray icon exists to relaunch from — that is true on darwin (the Dock icon
 * also keeps the app alive there) and is equally true on win32/linux once
 * state.tray is set. Only quit when there is truly nothing left to bring
 * the app back.
 *
 * Split out of app-lifecycle.ts (file-size cap) and to keep this decision
 * unit-testable without importing the whole startup sequence.
 */
import { app } from 'electron'
import { state } from './state'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

export function handleWindowAllClosed(): void {
  const trayResident = !!state.tray
  log('window-all-closed', { platform: process.platform, tray_resident: trayResident })
  if (!trayResident) app.quit()
}
