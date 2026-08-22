import { app, type WebContents } from 'electron'

declare const __ION_DESKTOP_VERSION__: string

import type { StartupReport, StartupSource, StartupState, StartupTarget } from '../shared/startup-state'
import { state } from './state'
import { log, warn } from './logger'
import { createStartupWindow } from './startup-window'
import { showWindow, createTray } from './window-manager'
import { registerActiveUiShortcuts } from './active-ui'
import { openStudioWindow, revealStudioWindow } from './studio-window-manager'
import { signIn } from './oauth/entra-auth'
import { broadcast } from './broadcast'

import type { SurfacePlan } from './surface-launch'

let target: StartupTarget | null = null
let launchPlan: SurfacePlan | null = null
let stateValue: StartupState = {
  sequence: 0,
  target: null,
  source: 'main',
  status: 'Starting Ion…',
  mode: 'loading',
  authenticationBusy: false,
  authenticationError: null,
  appVersion: __ION_DESKTOP_VERSION__,
  ownerReady: false,
  studioReady: false,
  error: null,
}
const sourceSequence: Record<StartupSource, number> = { main: -1, owner: -1, studio: -1 }
let revealed = false

function publish(): void {
  broadcast('startup:state', stateValue)
}

function expectedSender(source: StartupSource): WebContents | null {
  if (source === 'owner') return state.mainWindow?.webContents ?? null
  if (source === 'studio') return state.studioWindow?.webContents ?? null
  return null
}

function maybeReveal(): void {
  if (revealed || stateValue.mode === 'authentication' || stateValue.error || !target || !stateValue.ownerReady) return
  if (target === 'studio' && !stateValue.studioReady) return
  revealed = true
  if (target === 'overlay') showWindow('startup complete')
  else revealStudioWindow('startup complete')
  registerActiveUiShortcuts(launchPlan!)
  createTray()
  const splash = state.splashWindow
  if (splash && !splash.isDestroyed()) splash.destroy()
  log('startup', 'startup target revealed', { target })
}

export function startStartup(surfacePlan: SurfacePlan): void {
  target = surfacePlan.activeUi
  launchPlan = surfacePlan
  revealed = false
  sourceSequence.main = -1
  sourceSequence.owner = -1
  sourceSequence.studio = -1
  stateValue = {
    ...stateValue,
    target,
    mode: 'loading',
    authenticationBusy: false,
    authenticationError: null,
    appVersion: __ION_DESKTOP_VERSION__,
    ownerReady: false,
    studioReady: false,
    error: null,
  }
  createStartupWindow()
  reportStartup({ source: 'main', sequence: 0, status: 'Preparing Ion…' })
}

export function reportStartup(report: StartupReport, sender?: WebContents): boolean {
  if (report.source !== 'main') {
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
    ownerReady: stateValue.ownerReady || (report.source === 'owner' && report.ready === true),
    studioReady: stateValue.studioReady || (report.source === 'studio' && report.ready === true),
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
  if (report.source === 'owner' && report.ready && target === 'studio') prepareStudioStartup()
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
    const identity = await signIn()
    stateValue = {
      ...stateValue,
      sequence: stateValue.sequence + 1,
      mode: 'loading',
      authenticationBusy: false,
      authenticationError: null,
      status: 'Signed in. Preparing your workspace…',
    }
    publish()
    log('startup', 'required operator authentication completed', { user: identity.user })
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

export function prepareStudioStartup(): void {
  if (target !== 'studio') return
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
