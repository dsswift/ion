import { app, type WebContents } from 'electron'

declare const __ION_DESKTOP_VERSION__: string

import { STARTUP_PROGRESS_CHANNEL, isStartupReport, type StartupReport, type StartupSource, type StartupState } from '@ion/shared/startup-state'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { state } from './state'
import { debug, log, warn } from './logger'
import { createStartupWindow } from './startup-window'
import { createTray } from './window-manager'
import { registerStudioShortcuts } from './studio-shortcuts'
import { openStudioWindow, revealStudioWindow } from './studio-window-manager'
import { broker } from './connections/broker-instance'
import { broadcast } from './broadcast'

let stateValue: StartupState = {
  sequence: 0,
  source: 'main',
  status: 'Starting Ion…',
  mode: 'loading',
  authenticationBusy: false,
  authenticationError: null,
  appVersion: __ION_DESKTOP_VERSION__,
  studioReady: false,
  serverReady: false,
  error: null,
}
const sourceSequence: Record<StartupSource, number> = { main: -1, studio: -1, server: -1 }
let revealed = false

function publish(): void {
  broadcast('startup:state', stateValue)
}

function expectedSender(source: StartupSource): WebContents | null {
  if (source === 'studio') return state.studioWindow?.webContents ?? null
  // `main` reports come from this process; `server` reports arrive only
  // through relayServerStartupReport, off the LOCAL environment's wire.
  return null
}

/**
 * Reveal needs both ready reports. The renderer's arrives seconds before the
 * server's on any boot with saved tabs: the server restores tabs and starts
 * sessions for the long part of a boot, and the renderer's own bootstrap
 * does not wait on that (tabs hydrate from the wire as frames arrive).
 * Revealing on the renderer alone put a sidebar filling in chunk by chunk
 * over a "Syncing" placeholder on screen, which is the loading the splash
 * exists to cover. This is the owner-ready half of the gate the monolithic
 * desktop had; it went missing when the store moved into the server.
 */
function maybeReveal(): void {
  if (revealed || stateValue.mode === 'authentication' || stateValue.error) return
  if (!stateValue.studioReady || !stateValue.serverReady) return
  revealed = true
  revealStudioWindow('startup complete')
  registerStudioShortcuts()
  createTray()
  const splash = state.splashWindow
  if (splash && !splash.isDestroyed()) splash.destroy()
  log('startup', 'startup target revealed')
}

export function startStartup(): void {
  revealed = false
  sourceSequence.main = -1
  sourceSequence.studio = -1
  sourceSequence.server = -1
  stateValue = {
    ...stateValue,
    mode: 'loading',
    authenticationBusy: false,
    authenticationError: null,
    appVersion: __ION_DESKTOP_VERSION__,
    studioReady: false,
    serverReady: false,
    error: null,
  }
  createStartupWindow()
  reportStartup({ source: 'main', sequence: 0, status: 'Preparing Ion…' })
}

export function reportStartup(report: StartupReport, sender?: WebContents): boolean {
  // Only the renderer source carries a sender to check: `main` is this
  // process, and `server` reaches here solely through relayServerStartupReport
  // (ipc/startup.ts refuses any window claiming another source).
  if (report.source === 'studio') {
    const expected = expectedSender(report.source)
    if (!expected || sender?.id !== expected.id) {
      warn('startup', 'startup report rejected: unexpected sender', { source: report.source })
      return false
    }
  }
  if (report.sequence <= sourceSequence[report.source]) {
    // Never silent: a dropped report is indistinguishable from one that was
    // never sent, and the difference is the whole diagnosis when startup
    // wedges. A dropped `ready` in particular means the splash stays up and
    // the product window is never revealed.
    warn('startup', 'startup report dropped: sequence not ahead of source', {
      source: report.source,
      report_sequence: report.sequence,
      last_accepted_sequence: sourceSequence[report.source],
      status: report.status,
      ready: report.ready === true,
    })
    return false
  }
  sourceSequence[report.source] = report.sequence
  stateValue = {
    ...stateValue,
    sequence: stateValue.sequence + 1,
    source: report.source,
    status: report.status,
    authenticationBusy: stateValue.authenticationBusy,
    authenticationError: stateValue.authenticationError,
    studioReady: stateValue.studioReady || (report.source === 'studio' && report.ready === true),
    serverReady: stateValue.serverReady || (report.source === 'server' && report.ready === true),
    mode: report.error ? 'error' : stateValue.mode,
    error: report.error ?? stateValue.error,
  }
  log('startup', 'startup progress', {
    source: report.source,
    source_sequence: report.sequence,
    sequence: stateValue.sequence,
    status: report.status,
    ready: report.ready === true,
    error: report.error ?? '',
  })
  publish()
  maybeReveal()
  return true
}

export function requireStartupAuthentication(): void {
  stateValue = {
    ...stateValue,
    sequence: stateValue.sequence + 1,
    source: 'main',
    status: 'Sign in to continue',
    mode: 'authentication',
    authenticationBusy: false,
    authenticationError: null,
  }
  publish()
  log('startup', 'required operator authentication gate active')
}

/**
 * Abandon an in-flight sign-in attempt and return the gate to its idle state.
 *
 * The engine's PKCE flow has no cancel: it holds a loopback listener open and
 * times out after five minutes. Nothing in that window tells the desktop the
 * user gave up -- and a user who closes the browser tab, or is handed an error
 * page by the provider, has done exactly that. Before this existed the splash
 * sat on a disabled "Waiting for browser…" button for the full five minutes
 * with no way back, so the only way to retry was to quit the application.
 *
 * This resets the desktop's own view so the button is usable again. The
 * engine's abandoned attempt expires on its own; a fresh authenticate() starts
 * a new flow with a new listener, and whichever completes first signs the
 * operator in.
 */
export function cancelStartupAuthentication(): void {
  if (stateValue.mode !== 'authentication') {
    log('startup', 'authentication cancel ignored; gate is not active', { mode: stateValue.mode })
    return
  }
  stateValue = {
    ...stateValue,
    sequence: stateValue.sequence + 1,
    authenticationBusy: false,
    authenticationError: null,
    status: 'Sign in to continue',
  }
  publish()
  log('startup', 'required operator authentication cancelled by user')
}

export async function authenticateStartup(): Promise<void> {
  if (stateValue.mode !== 'authentication') {
    throw new Error('startup authentication is not required')
  }
  if (stateValue.authenticationBusy) {
    throw new Error('startup authentication is already in progress')
  }
  stateValue = {
    ...stateValue,
    sequence: stateValue.sequence + 1,
    authenticationBusy: true,
    authenticationError: null,
    status: 'Complete sign-in in your browser…',
  }
  publish()
  log('startup', 'required operator authentication started')
  try {
    // The engine-owned PKCE flow, through the local server (`entra.signIn`).
    const result = await broker.sendAction(LOCAL_ENVIRONMENT_ID, 'entra.signIn', []) as { ok: boolean; identity?: { user: string }; error?: string }
    if (!result.ok || !result.identity) throw new Error(result.error ?? 'sign-in failed')
    const identity = result.identity
    stateValue = {
      ...stateValue,
      sequence: stateValue.sequence + 1,
      mode: 'loading',
      authenticationBusy: false,
      authenticationError: null,
      status: 'Signed in. Preparing your workspace…',
    }
    publish()
    log('startup', 'required operator authentication completed', { signed_in_user: identity.user })
    // The gate blocks reveal while mode is 'authentication', and both ready
    // reports can arrive before this promise settles: the main-process wait
    // loop polls the engine every 250ms and proceeds on the engine's own view
    // of the grant, which becomes signed-in the moment the token exchange
    // completes -- while signIn() is still finishing its own bookkeeping.
    // Observed on Windows: owner ready at 19:03:06.645 and studio ready at
    // 19:03:07.081, both refused, then this line at 19:03:07.736 with nothing
    // left to call maybeReveal. The splash sat on "Signed in. Preparing your
    // workspace…" over a fully booted application.
    maybeReveal()
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    stateValue = {
      ...stateValue,
      sequence: stateValue.sequence + 1,
      authenticationBusy: false,
      authenticationError: error,
      status: 'Sign in to continue',
    }
    publish()
    warn('startup', 'required operator authentication failed', { error })
    throw err
  }
}

export function failStartup(message: string): void {
  reportStartup({ source: 'main', sequence: sourceSequence.main + 1, status: 'Ion could not start', error: message })
}

export function getStartupState(): StartupState {
  return stateValue
}

export function isStartupRevealed(): boolean {
  return revealed
}

export function isSplashSender(sender: WebContents): boolean {
  const splash = state.splashWindow
  if (!splash || splash.isDestroyed()) return false
  return sender.id === splash.webContents.id
}

/** Create the (hidden) Studio window so its renderer can start loading and reporting readiness. Revealed later by {@link maybeReveal} once it reports ready. */
export function prepareStudioStartup(): void {
  openStudioWindow('startup', false)
}

export function restartStartup(): void {
  log('startup', 'restart requested from splash')
  app.relaunch()
  app.exit(0)
}

export function quitStartup(): void {
  log('startup', 'quit requested from splash')
  app.quit()
}

/**
 * The server-sourced startup report carried by a wire frame, or null when the
 * frame is anything else. Only the LOCAL environment's server drives this
 * desktop's splash: a remote environment restoring its tabs is not this
 * boot. A report claiming another source is dropped, since `server` is the
 * only source that may arrive without a sender window.
 */
export function serverStartupReportFromFrame(environmentId: string, frame: StudioFrame): StartupReport | null {
  if (environmentId !== LOCAL_ENVIRONMENT_ID) return null
  if (frame.type !== 'studio_event' || frame.channel !== STARTUP_PROGRESS_CHANNEL) return null
  // `broadcast(channel, report)` is a one-argument publish, which the
  // server's formatEventPayload delivers as the bare report object.
  const report: unknown = frame.payload
  if (!isStartupReport(report) || report.source !== 'server') {
    warn('startup', 'server startup report rejected: malformed or wrong source', { environment_id: environmentId })
    return null
  }
  return report
}

/**
 * Relays a server startup report into the coordinator; a no-op for any other
 * frame. The server replays its latest report to every connection that
 * attaches, including the terminal "ready" one, so a desktop that connects
 * after a fast restore still sees it. Once the window is revealed those
 * replays (on every reconnect) say nothing the splash can use, so they are
 * noted rather than pushed through the sequence check, which would log each
 * one as a dropped report.
 */
export function relayServerStartupReport(environmentId: string, frame: StudioFrame): boolean {
  const report = serverStartupReportFromFrame(environmentId, frame)
  if (!report) return false
  if (revealed) {
    debug('startup', 'server startup report after reveal ignored', { sequence: report.sequence, status: report.status, ready: report.ready === true })
    return false
  }
  return reportStartup(report)
}
