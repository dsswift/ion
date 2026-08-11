/**
 * `ion://` URL-scheme wiring.
 *
 * Kept out of app-lifecycle.ts, which is near the file-size cap and is a
 * sequencing file rather than a feature file: this module owns the whole
 * scheme-registration story and exposes one call to make it live.
 *
 * ── Why the single-instance lock is mandatory here ───────────────────────────
 * `open ion://…` launches the app when it is not running. Without a lock, a
 * click while Ion IS running starts a SECOND Ion — two engine bootstraps, two
 * tab stores, two windows fighting over the same files. The lock makes the
 * second process hand its URL to the first and exit, which is also the only way
 * `second-instance` ever fires.
 *
 * ── The three arrival paths, all of which must work ──────────────────────────
 *   1. `open-url` while running (macOS delivers the URL as an event).
 *   2. `second-instance` (a second launch hands over its argv; on Windows and
 *      Linux this is the ONLY path, since the URL arrives as an argument).
 *   3. Cold launch (the URL is in this process's own argv, or arrived via
 *      `open-url` before the renderer existed). The dispatcher queues anything
 *      that lands before the store is ready, so all three converge.
 */

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { resolve as resolvePath } from 'path'
import { log as _log, warn as _warn } from './logger'
import { handleDeepLink, configureDeepLinks } from './deeplink/dispatch'
import { ensureHandoffDir } from './deeplink/handoff'
import { getDeepLinkToken } from './deeplink/token'
import { markDeepLinkConfirmationReady, markDeepLinkConfirmationUnavailable, rejectAllDeepLinkConfirmations } from './deeplink/confirm'
import { showWindow } from './window-manager'
import { openAtvWindow } from './atv-window-manager'
import { readSettings } from './settings-store'
import type { DeepLinkConfirmOwner } from '../shared/types-ipc'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export const ION_SCHEME = 'ion'

function presentConfirmation(): DeepLinkConfirmOwner | null {
  try {
    const settings = readSettings()
    if (settings.surfacePolicy === 'atv-only') {
      openAtvWindow('deeplink confirmation')
      return 'atv'
    }
    showWindow('deeplink confirmation')
    return 'overlay'
  } catch (err) {
    warn('confirmation surface resolution failed', { error: String(err) })
    return null
  }
}

export function bindDeepLinkRenderer(owner: DeepLinkConfirmOwner, win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => markDeepLinkConfirmationReady(owner))
  win.on('closed', () => {
    markDeepLinkConfirmationUnavailable(owner, 'window closed')
    if (owner === 'overlay') rejectAllDeepLinkConfirmations('main window closed')
  })
}

/** Pick `ion://…` out of an argv, which also carries flags and the exec path. */
export function extractIonUrl(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith(`${ION_SCHEME}://`)) return arg
  }
  return null
}

/**
 * Claim the single-instance lock.
 *
 * Returns false when another Ion already holds it, in which case the caller must
 * quit immediately WITHOUT any startup work — a second process that bootstraps
 * the engine or opens a window before quitting is the bug the lock exists to
 * prevent. The URL this process was launched with reaches the first instance via
 * its `second-instance` handler.
 */
export function claimSingleInstance(): boolean {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    log('another instance holds the lock; handing off and quitting')
    return false
  }
  return true
}

/**
 * Register the scheme and wire every arrival path.
 *
 * Called once during startup, before `whenReady` resolves, so a cold-launch URL
 * is not missed while the app is still booting.
 */
export function setupDeepLinks(): void {
  configureDeepLinks({ presentConfirmation })

  // Mint the token now so a tool that reads it at any point after startup finds
  // it, and create the handoff directory so a caller never has to (and cannot
  // create it with the wrong mode).
  getDeepLinkToken()
  ensureHandoffDir()

  // In dev the executable is Electron itself, so the scheme must be registered
  // against the app path for the OS to route back to this project rather than to
  // a packaged Ion.
  const registered = process.defaultApp && process.argv.length >= 2
    ? app.setAsDefaultProtocolClient(ION_SCHEME, process.execPath, [resolvePath(process.argv[1])])
    : app.setAsDefaultProtocolClient(ION_SCHEME)
  log('registered url scheme', { scheme: ION_SCHEME, registered })

  // Path 1: macOS delivers a URL to a running app here.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    log('open-url received', { url_length: url.length })
    void handleDeepLink(url).catch((err) => {
      warn('open-url deep link failed', { error: String(err) })
    })
  })

  // Path 2: a second launch. Its argv carries the URL on every platform, and on
  // Windows/Linux this is the only delivery mechanism.
  app.on('second-instance', (_event, argv) => {
    const url = extractIonUrl(argv)
    if (!url) {
      // A plain second launch with no URL: the operator is trying to reach Ion,
      // so surface the window rather than doing nothing.
      log('second instance with no url; surfacing window')
      showWindow('second instance')
      return
    }
    log('second-instance url received', { url_length: url.length })
    void handleDeepLink(url).catch((err) => {
      warn('second-instance deep link failed', { error: String(err) })
    })
  })
}

/**
 * Handle a URL this process was launched with.
 *
 * Called after the window exists. The dispatcher queues until the renderer is
 * ready, so calling this early is safe.
 */
export function consumeLaunchUrl(argv: string[] = process.argv): void {
  const url = extractIonUrl(argv)
  if (!url) return
  log('cold-launch url found in argv', { url_length: url.length })
  void handleDeepLink(url).catch((err) => {
    warn('cold-launch deep link failed', { error: String(err) })
  })
}
