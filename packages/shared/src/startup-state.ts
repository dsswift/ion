/**
 * Who a startup report comes from. `main` is the desktop main process,
 * `studio` the Studio renderer, and `server` the Studio server child, whose
 * tab and session restoration is the long part of a boot: it reports each
 * phase and each tab over the wire on `STARTUP_PROGRESS_CHANNEL` so the
 * splash shows the same detail it did when that work ran in the renderer.
 *
 * The window is revealed only once BOTH `studio` and `server` have reported
 * `ready`. The renderer is ready as soon as its own bootstrap finishes, which
 * is seconds before the server has restored every tab; revealing on the
 * renderer alone shows a sidebar that fills in chunk by chunk over a
 * "Syncing" placeholder -- the exact loading the splash exists to cover.
 */
export type StartupSource = 'main' | 'studio' | 'server'

/** `studio_event` channel the server publishes its startup reports on. */
export const STARTUP_PROGRESS_CHANNEL = 'startup:progress'

export function isStartupSource(value: unknown): value is StartupSource {
  return value === 'main' || value === 'studio' || value === 'server'
}
export type StartupMode = 'loading' | 'authentication' | 'error'

export interface StartupState {
  sequence: number
  source: StartupSource
  status: string
  mode: StartupMode
  authenticationBusy: boolean
  authenticationError: string | null
  appVersion: string
  studioReady: boolean
  /** The LOCAL Studio server has finished restoring tabs and sessions. */
  serverReady: boolean
  error: string | null
}

export interface StartupReport {
  source: StartupSource
  sequence: number
  status: string
  ready?: boolean
  error?: string
}

export function isStartupReport(value: unknown): value is StartupReport {
  if (!value || typeof value !== 'object') return false
  const report = value as Record<string, unknown>
  return (
    isStartupSource(report.source) &&
    typeof report.sequence === 'number' &&
    Number.isSafeInteger(report.sequence) &&
    report.sequence >= 0 &&
    typeof report.status === 'string' &&
    report.status.length <= 240 &&
    (report.ready === undefined || typeof report.ready === 'boolean') &&
    (report.error === undefined || (typeof report.error === 'string' && report.error.length <= 1_000))
  )
}

export function isStartupState(value: unknown): value is StartupState {
  if (!value || typeof value !== 'object') return false
  const state = value as Record<string, unknown>
  return (
    typeof state.sequence === 'number' &&
    Number.isSafeInteger(state.sequence) &&
    isStartupSource(state.source) &&
    typeof state.status === 'string' &&
    (state.mode === 'loading' || state.mode === 'authentication' || state.mode === 'error') &&
    typeof state.authenticationBusy === 'boolean' &&
    (typeof state.authenticationError === 'string' || state.authenticationError === null) &&
    typeof state.appVersion === 'string' &&
    typeof state.studioReady === 'boolean' &&
    typeof state.serverReady === 'boolean' &&
    (typeof state.error === 'string' || state.error === null)
  )
}
