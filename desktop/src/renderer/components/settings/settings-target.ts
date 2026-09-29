/**
 * settings-target — which server the Settings dialog is editing.
 *
 * Settings has four kinds of setting (`@ion/shared/settings-registry`). Two
 * live on this client and are the same whichever server is picked. Two live
 * on a server: its Environment settings, and your Account settings there. The
 * dialog used to edit the LOCAL server always, whatever conversation was on
 * screen, so another server's auto-settle window or your default model there
 * could not be seen or changed from here.
 *
 * Every settings page reads and writes through `useSettingsPreferences`. For
 * the local server that is the app-wide preference store. For any other
 * server it is a SECOND instance of the same store, built from the same state
 * creator, so every page and every setter works unchanged:
 *
 *   - it is BOUND to that server when it is created (`bindSettingsTarget`),
 *     so every save it makes goes there. The binding belongs to the store,
 *     not to the call stack, so a save made after an await cannot fall back
 *     to the local server;
 *   - it hydrates through the same loader, told which server to read from
 *     and to write its load-time clean-ups back to;
 *   - client-owned keys are mirrored both ways with the app-wide store, so a
 *     theme change made here still restyles the app;
 *   - a change that server announces (`ion:settings-changed`) is applied.
 *
 * An Environment setting needs the `admin` scope on that server. Without it
 * the change is put back at once and a notice is raised, instead of being
 * shown and then refused by the server.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import { useSyncExternalStore } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { settingScope } from '@ion/shared/settings-registry'
import type { PreferencesState } from '@ion/server/preferences-types'
import { createPreferencesState, usePreferencesStore } from '../../preferences'
import { bindSettingsTarget, loadPersistedSettings } from '../../preferences-persist'
import { isClientOwnedSetting } from '../../preferences-scope-transport'
import { canManageEnvironment, useEnvironmentSettingsStore } from '../../studio/state/environment-settings-store'
import { rInfo, rWarn } from '../../rendererLogger'

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>

interface Target {
  environmentId: string
  store: PreferencesStore
  dispose(): void
}

let target: Target = { environmentId: LOCAL_ENVIRONMENT_ID, store: usePreferencesStore, dispose: () => {} }
let notice: string | null = null
const listeners = new Set<() => void>()
function emit(): void { for (const listener of listeners) listener() }
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

function changedKeys(next: PreferencesState, prev: PreferencesState, keep: (key: string) => boolean): Partial<PreferencesState> {
  const patch: Record<string, unknown> = {}
  const a = next as unknown as Record<string, unknown>
  const b = prev as unknown as Record<string, unknown>
  for (const key of Object.keys(a)) {
    if (typeof a[key] !== 'function' && a[key] !== b[key] && keep(key)) patch[key] = a[key]
  }
  return patch as Partial<PreferencesState>
}

/** Keys of `patch` that are Environment settings. */
export function environmentKeysOf(patch: object): string[] {
  return Object.keys(patch).filter((key) => settingScope(key) === 'environment')
}

function buildEnvironmentStore(environmentId: string): Target {
  // Bound to this server before the state exists, so every save the store
  // ever makes goes there -- including one made after an await, which an
  // ambient "current target" would already have let go of.
  const store = create<PreferencesState>((set, get, api) => {
    bindSettingsTarget(set, environmentId)
    return createPreferencesState(set, get, api)
  })
  const state = store.getState() as unknown as Record<string, unknown>
  // An Environment change made without `admin` there is put back.
  const wrapped: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(state)) {
    if (typeof value !== 'function') continue
    wrapped[name] = (...args: unknown[]) => {
      const before = store.getState()
      const result = (value as (...a: unknown[]) => unknown)(...args)
      const refused = environmentKeysOf(changedKeys(store.getState(), before, () => true))
      if (refused.length > 0 && !canManageEnvironment(useEnvironmentSettingsStore.getState(), environmentId)) {
        const restore: Record<string, unknown> = {}
        for (const key of refused) restore[key] = (before as unknown as Record<string, unknown>)[key]
        store.setState(restore as Partial<PreferencesState>)
        rWarn('settings.target', 'environment setting change put back: this connection lacks admin there', { environment_id: environmentId, keys: refused })
        notice = 'Only a device with admin access to this server can change its server-wide settings.'
        emit()
      }
      return result
    }
  }
  store.setState(wrapped as Partial<PreferencesState>)

  // Same loader as the app-wide store, told which server to read from and to
  // write its load-time clean-ups back to. The theme is already applied by
  // the app-wide store, so the loader's theme hook is inert.
  void loadPersistedSettings((patch) => store.setState(patch), store.getState, () => {}, environmentId)

  // Device policy is this machine's, whichever server is picked: a locked
  // theme stays locked. The app-wide store holds the
  // local policy; without it here the locks would read as absent, the
  // controls would unlock, and the change would reach the app-wide store
  // through the client-owned mirror below, around the setter that guards it.
  // A picked server's own policy is never copied in: it must not narrow this
  // device's UI, and the pages that need it read it from the policy store.
  const devicePolicyOf = (s: PreferencesState): Pick<PreferencesState, 'enterprisePolicy' | 'enterpriseNewConversationDefaults'> =>
    ({ enterprisePolicy: s.enterprisePolicy, enterpriseNewConversationDefaults: s.enterpriseNewConversationDefaults })
  store.setState(devicePolicyOf(usePreferencesStore.getState()))
  const offPolicy = usePreferencesStore.subscribe((next, prev) => {
    if (next.enterprisePolicy !== prev.enterprisePolicy || next.enterpriseNewConversationDefaults !== prev.enterpriseNewConversationDefaults) {
      store.setState(devicePolicyOf(next))
    }
  })

  // Client-owned keys are one truth, shared with the app-wide store.
  const offScoped = store.subscribe((next, prev) => {
    const patch = changedKeys(next, prev, isClientOwnedSetting)
    if (Object.keys(patch).length > 0) usePreferencesStore.setState(patch)
  })
  const offGlobal = usePreferencesStore.subscribe((next, prev) => {
    const patch = changedKeys(next, prev, isClientOwnedSetting)
    if (Object.keys(patch).length > 0) store.setState(patch)
  })
  // What that server announces. Reference equality keeps this from looping.
  const offServer = useEnvironmentSettingsStore.subscribe((next, prev) => {
    const now = next.byEnvironment[environmentId]?.settings ?? {}
    const was = prev.byEnvironment[environmentId]?.settings ?? {}
    const current = store.getState() as unknown as Record<string, unknown>
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(now)) {
      if (value !== was[key] && key in current && current[key] !== value) patch[key] = value
    }
    if (Object.keys(patch).length > 0) store.setState(patch as Partial<PreferencesState>)
  })
  return { environmentId, store, dispose: () => { offPolicy(); offScoped(); offGlobal(); offServer() } }
}

/** Point Settings at one server. The local server is the app-wide store itself. */
export function setSettingsTarget(environmentId: string): void {
  if (environmentId === target.environmentId) return
  target.dispose()
  target = environmentId === LOCAL_ENVIRONMENT_ID
    ? { environmentId, store: usePreferencesStore, dispose: () => {} }
    : buildEnvironmentStore(environmentId)
  notice = null
  rInfo('settings.target', 'settings target changed', { environment_id: environmentId })
  emit()
}

export function settingsTargetEnvironmentId(): string { return target.environmentId }

/** The server Settings is editing; re-renders when it changes. */
export function useSettingsTargetEnvironmentId(): string {
  return useSyncExternalStore(subscribe, settingsTargetEnvironmentId)
}

/** The last refusal raised by the target, or null. */
export function useSettingsTargetNotice(): string | null {
  return useSyncExternalStore(subscribe, () => notice)
}

export function clearSettingsTargetNotice(): void {
  if (notice === null) return
  notice = null
  emit()
}

/**
 * The preference store for the server Settings is editing. Same surface as
 * `usePreferencesStore`, which it IS for the local server. The dialog
 * remounts its pages when the target changes, so a page binds to one store
 * for its whole life.
 */
export const useSettingsPreferences = Object.assign(
  function useSettingsPreferences<T>(selector: (state: PreferencesState) => T): T {
    return target.store(selector)
  },
  {
    getState: (): PreferencesState => target.store.getState(),
    setState: (patch: Partial<PreferencesState>): void => target.store.setState(patch),
  },
)
