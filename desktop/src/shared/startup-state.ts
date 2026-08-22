export type StartupSource = 'main' | 'owner' | 'studio'
export type StartupTarget = 'overlay' | 'studio'
export type StartupMode = 'loading' | 'authentication' | 'error'

export interface StartupState {
  sequence: number
  target: StartupTarget | null
  source: StartupSource
  status: string
  mode: StartupMode
  authenticationBusy: boolean
  authenticationError: string | null
  appVersion: string
  ownerReady: boolean
  studioReady: boolean
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
    (report.source === 'main' || report.source === 'owner' || report.source === 'studio') &&
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
    (state.target === 'overlay' || state.target === 'studio' || state.target === null) &&
    (state.source === 'main' || state.source === 'owner' || state.source === 'studio') &&
    typeof state.status === 'string' &&
    (state.mode === 'loading' || state.mode === 'authentication' || state.mode === 'error') &&
    typeof state.authenticationBusy === 'boolean' &&
    (typeof state.authenticationError === 'string' || state.authenticationError === null) &&
    typeof state.appVersion === 'string' &&
    typeof state.ownerReady === 'boolean' &&
    typeof state.studioReady === 'boolean' &&
    (typeof state.error === 'string' || state.error === null)
  )
}
