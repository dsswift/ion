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
import { openStudioWindow } from './studio-window-manager'
import { broker } from './connections/broker-instance'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { DeepLinkConfirmOwner } from '@ion/shared/types-ipc'
import { FORCE_QUIT_ARG } from './force-quit-arg'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export const ION_SCHEME = 'ion'

/**
 * Hand an OS-delivered `ion://` URL to the Studio server, which owns the
 * dispatcher, the confirmations and the store the actions drive. This
 * process only receives the URL.
 */
export function handleDeepLink(url: string): Promise<unknown> {
  return broker.sendAction(LOCAL_ENVIRONMENT_ID, 'deeplink.dispatch', [url])
}

/**
 * The window that hosts the confirmation dialog. Its renderer reports its
 * own readiness (`deeplink.setConfirmAvailability`); this process reports
 * only what the renderer cannot: that the window is gone, so pending
 * confirmations settle as declined instead of waiting out their timeout.
 */
export function bindDeepLinkRenderer(owner: DeepLinkConfirmOwner, win: BrowserWindow): void {
  win.on('closed', () => {
    broker.sendAction(LOCAL_ENVIRONMENT_ID, 'deeplink.surfaceClosed', [{ owner }]).catch((err) => {
      warn('surface-closed report failed', { owner, error: String(err) })
    })
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
  // The dispatcher, the token the terminals carry and the handoff directory
  // are the Studio server's (it mints and creates them at boot); this process
  // only registers the scheme and forwards what the OS delivers.

  // In dev the executable is Electron itself, so the scheme must be registered
  // against the app path for the OS to route back to this project rather than to
  // a packaged Ion.
  //
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
    // A forced quit is the quit handler's; surfacing a window would only
    // flash one on the way out.
    if (argv.includes(FORCE_QUIT_ARG)) return
    const url = extractIonUrl(argv)
    if (!url) {
      // A plain second launch should reveal the one active conversation UI.
      // Never show the hidden Overlay while Studio is active.
      log('second instance with no url; surfacing active UI')
      openStudioWindow('second instance')
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
