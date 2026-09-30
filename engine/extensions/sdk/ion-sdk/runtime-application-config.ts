// Ion Extension SDK — authenticated application config runtime.
//
// Implements ctx.applicationConfig over ext/get_application_config and
// ext/await_application_config. The engine owns resolution, caching,
// scoping to the reader's principal and to this extension's allowlist
// identity, and withholding secret values; this module only decodes answers.

import type {
  ApplicationConfigAwaitResult,
  ApplicationConfigSnapshot,
  ApplicationConfigState,
  ApplicationConfigValue,
  IonApplicationConfig,
} from './types'

type Request = (method: string, params: Record<string, unknown>) => Promise<any>

const STATES: ReadonlySet<string> = new Set(['disabled', 'deferred', 'fetching', 'ready', 'refreshing', 'failed'])

function decodeState(value: unknown): ApplicationConfigState {
  // An engine that predates this surface answers nothing usable; reading it
  // as disabled matches "no source configured".
  return typeof value === 'string' && STATES.has(value) ? (value as ApplicationConfigState) : 'disabled'
}

function decodeSnapshot(result: any): ApplicationConfigSnapshot {
  const snapshot: ApplicationConfigSnapshot = {
    state: decodeState(result?.state),
    revision: typeof result?.revision === 'number' ? result.revision : 0,
  }
  if (typeof result?.subject === 'string') snapshot.subject = result.subject
  if (typeof result?.provider === 'string') snapshot.provider = result.provider
  if (result?.values && typeof result.values === 'object') snapshot.values = result.values as Record<string, unknown>
  if (Array.isArray(result?.secretKeys)) {
    snapshot.secretKeys = result.secretKeys.filter((key: unknown): key is string => typeof key === 'string')
  }
  if (typeof result?.error === 'string') snapshot.error = result.error
  if (typeof result?.fetchedAt === 'string') snapshot.fetchedAt = result.fetchedAt
  return snapshot
}

export function buildApplicationConfigAPI(request: Request): IonApplicationConfig {
  return {
    async snapshot(): Promise<ApplicationConfigSnapshot> {
      return decodeSnapshot(await request('ext/get_application_config', {}))
    },
    async get(key: string): Promise<ApplicationConfigValue> {
      const result = await request('ext/get_application_config', { key })
      const value: ApplicationConfigValue = {
        state: decodeState(result?.state),
        revision: typeof result?.revision === 'number' ? result.revision : 0,
        key,
        found: result?.found === true,
        secret: result?.secret === true,
      }
      if (typeof result?.error === 'string') value.error = result.error
      if (value.found) value.value = result.value
      return value
    },
    async await(opts?: { timeoutMs?: number }): Promise<ApplicationConfigAwaitResult> {
      const result = await request('ext/await_application_config', { timeoutMs: opts?.timeoutMs || 0 })
      return { ...decodeSnapshot(result), timedOut: result?.timedOut === true }
    },
  }
}
