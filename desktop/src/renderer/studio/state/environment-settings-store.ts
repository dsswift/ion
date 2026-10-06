/**
 * environment-settings-store — what each connected server holds for you.
 *
 * Two of the four settings scopes live on a server (`@ion/shared/
 * settings-registry`): an Environment setting is one value for that whole
 * server, and an Account setting is yours on that server. Neither can be read
 * from this client's own preferences, because this client's preferences are
 * the LOCAL server's. A conversation on another server, and the Settings
 * page of another server, need that server's values: its default model for
 * you, its auto-settle window.
 *
 * Each server sends your effective settings on `studio_welcome` and announces
 * changes on `ion:settings-changed`. This store keeps them per environment,
 * plus the scopes this connection was granted there, which is what decides
 * whether an Environment setting may be changed from here (`admin`).
 *
 * Personal and Device settings never enter this store: they live on this
 * client, not on any server.
 */
import { create } from 'zustand'
import type { Scope } from '@ion/shared/studio-wire/types'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { settingScope } from '@ion/shared/settings-registry'
import { host, action } from '../../host/host-instance'
import { rInfo, rWarn } from '../../rendererLogger'

export interface EnvironmentSettings {
  /** Environment and Account keys only, as that server resolved them for this person. */
  settings: Record<string, unknown>
  /** What this connection may do on that server. */
  scopes: readonly Scope[]
}

const EMPTY: EnvironmentSettings = { settings: {}, scopes: [] }

interface EnvironmentSettingsState {
  byEnvironment: Record<string, EnvironmentSettings>
  hydrate(environmentId: string, settings: Record<string, unknown>, scopes: readonly Scope[]): void
  patch(environmentId: string, key: string, value: unknown): void
  clear(environmentId: string): void
}

/** True for a key that lives on a server. Anything else is this client's own and is kept out. */
function livesOnServer(key: string): boolean {
  const scope = settingScope(key)
  return scope === 'environment' || scope === 'account'
}

function serverKeysOnly(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (livesOnServer(key)) out[key] = value
  }
  return out
}

export const useEnvironmentSettingsStore = create<EnvironmentSettingsState>((set) => ({
  byEnvironment: {},
  hydrate: (environmentId, settings, scopes) => set((s) => ({
    byEnvironment: { ...s.byEnvironment, [environmentId]: { settings: serverKeysOnly(settings), scopes: [...scopes] } },
  })),
  patch: (environmentId, key, value) => set((s) => {
    if (!livesOnServer(key)) return s
    const current = s.byEnvironment[environmentId] ?? EMPTY
    if (current.settings[key] === value) return s
    return { byEnvironment: { ...s.byEnvironment, [environmentId]: { ...current, settings: { ...current.settings, [key]: value } } } }
  }),
  clear: (environmentId) => set((s) => {
    if (!(environmentId in s.byEnvironment)) return s
    const { [environmentId]: _gone, ...rest } = s.byEnvironment
    return { byEnvironment: rest }
  }),
}))

/** One server's settings for this person; empty until that server's welcome arrives. */
export function environmentSettings(state: Pick<EnvironmentSettingsState, 'byEnvironment'>, environmentId: string): EnvironmentSettings {
  return state.byEnvironment[environmentId] ?? EMPTY
}

/** One setting on one server, or `undefined` when that server has not said. */
export function environmentSetting<T>(state: Pick<EnvironmentSettingsState, 'byEnvironment'>, environmentId: string, key: string): T | undefined {
  return environmentSettings(state, environmentId).settings[key] as T | undefined
}

/** Whether this connection may change that server's Environment settings. The server enforces the same rule. */
export function canManageEnvironment(state: Pick<EnvironmentSettingsState, 'byEnvironment'>, environmentId: string): boolean {
  return scopeSatisfies(environmentSettings(state, environmentId).scopes, 'admin')
}

/**
 * Whether this connection may run a terminal, a bash command, a Quick Tool, or
 * a port forward on that server. Absent until that server's welcome arrives, so
 * a surface that needs it stays hidden rather than flashing in and out. The
 * server refuses the same actions without `terminal:operate`.
 */
export function canOperateTerminal(state: Pick<EnvironmentSettingsState, 'byEnvironment'>, environmentId: string): boolean {
  return scopeSatisfies(environmentSettings(state, environmentId).scopes, 'terminal:operate')
}

/**
 * Change settings on one server. The value is applied here first so the
 * control does not snap back while the round trip is in flight, and put back
 * when the server refuses (an Environment key without `admin`).
 */
export async function saveEnvironmentSettings(environmentId: string, patch: Record<string, unknown>): Promise<void> {
  const store = useEnvironmentSettingsStore.getState()
  const before = environmentSettings(store, environmentId).settings
  const previous: Record<string, unknown> = {}
  for (const key of Object.keys(patch)) {
    if (!livesOnServer(key)) {
      rWarn('environment-settings', 'refusing to send a client-owned setting to a server', { environment_id: environmentId, key })
      throw new Error(`${key} is not a server setting`)
    }
    previous[key] = before[key]
    store.patch(environmentId, key, patch[key])
  }
  try {
    await action(environmentId, 'settings.save', [patch])
    rInfo('environment-settings', 'settings saved', { environment_id: environmentId, keys: Object.keys(patch) })
  } catch (err) {
    for (const [key, value] of Object.entries(previous)) useEnvironmentSettingsStore.getState().patch(environmentId, key, value)
    rWarn('environment-settings', 'save refused or failed; value restored', { environment_id: environmentId, keys: Object.keys(patch), error: String(err) })
    throw err
  }
}

/** Wire the store to every environment's frames. Returns the unsubscribe. */
export function initEnvironmentSettingsFromWire(): () => void {
  return host.onFrame((environmentId, frame) => {
    if (frame.type === 'studio_welcome') {
      useEnvironmentSettingsStore.getState().hydrate(environmentId, frame.snapshot.settings as Record<string, unknown>, frame.scopes)
      rInfo('environment-settings', 'hydrated from welcome', { environment_id: environmentId, can_manage: scopeSatisfies(frame.scopes, 'admin') })
    } else if (frame.type === 'studio_snapshot') {
      // A snapshot carries current settings but no scopes: keep the ones the
      // welcome granted. It is how a window that attached after the welcome
      // converges on what the server holds now.
      const scopes = environmentSettings(useEnvironmentSettingsStore.getState(), environmentId).scopes
      useEnvironmentSettingsStore.getState().hydrate(environmentId, frame.snapshot.settings as Record<string, unknown>, scopes)
      rInfo('environment-settings', 'refreshed from snapshot', { environment_id: environmentId })
    } else if (frame.type === 'studio_event' && frame.channel === 'ion:settings-changed' && Array.isArray(frame.payload)) {
      const [key, value] = frame.payload as [unknown, unknown]
      if (typeof key === 'string') useEnvironmentSettingsStore.getState().patch(environmentId, key, value)
    }
  })
}
