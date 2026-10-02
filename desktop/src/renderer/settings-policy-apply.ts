/**
 * Applies device policy's settings classes to this client's preferences.
 *
 *   sealed, with a value     The value is shown and used, in memory only.
 *                            What the person saved stays on disk, so it is
 *                            back when the seal lifts.
 *   managed-default          The value is written once per policy value. The
 *                            person may change it; a policy that later
 *                            carries a different value supplies that one.
 *
 * A policy value whose shape does not match the preference it names is not
 * applied. The key stays refused to writers either way.
 */
import type { StoreApi, UseBoundStore } from 'zustand'
import { managedDefaultSettingValues, sealedSettingValues, stableStringify } from '@ion/shared/enterprise-settings-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { PreferencesState } from '@ion/server/preferences-types'
import { host } from './host/host-instance'
import { managedDefaultValueApplied, recordManagedDefaultValue } from './managed-defaults'
import { saveSettings } from './preferences-persist'
import { rError, rInfo, rWarn } from './rendererLogger'

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>

/** True when `value` could stand where `current` is: same primitive type, or both lists, or both records. */
function sameShape(current: unknown, value: unknown): boolean {
  if (current === null || current === undefined) return true
  return typeof current === typeof value && Array.isArray(current) === Array.isArray(value) && value !== null
}

function applySealedValues(store: PreferencesStore, policy: EnterprisePolicy | null): void {
  const state = store.getState() as unknown as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(sealedSettingValues(policy, 'ion-desktop'))) {
    // The theme has its own path: the enforced palette is applied without
    // replacing the person's saved pick in the store.
    if (key === 'selectedTheme' || !(key in state) || typeof state[key] === 'function') continue
    if (!sameShape(state[key], value)) {
      rWarn('preferences', 'sealed setting has a policy value of the wrong shape; not applied', { key, expected: typeof state[key], got: typeof value })
      continue
    }
    if (stableStringify(state[key]) !== stableStringify(value)) patch[key] = value
  }
  if (Object.keys(patch).length === 0) return
  store.setState(patch as Partial<PreferencesState>)
  rInfo('preferences', 'sealed setting values applied', { keys: Object.keys(patch) })
}

function supplyManagedDefaults(store: PreferencesStore, policy: EnterprisePolicy | null): void {
  for (const [key, value] of Object.entries(managedDefaultSettingValues(policy, 'ion-desktop'))) {
    const signature = stableStringify(value)
    if (managedDefaultValueApplied(key) === signature) continue
    const state = store.getState() as unknown as Record<string, unknown>
    if (key in state && typeof state[key] !== 'function') {
      if (!sameShape(state[key], value)) {
        rWarn('preferences', 'managed default has a policy value of the wrong shape; not supplied', { key, expected: typeof state[key], got: typeof value })
        continue
      }
      if (key === 'selectedTheme') store.getState().setSelectedTheme(value as string)
      else {
        store.setState({ [key]: value } as Partial<PreferencesState>)
        saveSettings({ [key]: value })
      }
    } else {
      // A client setting the preference store does not hold. The Studio
      // surface's own keys have their own funnel; the rest is device state.
      const write = key.startsWith('studio') ? host.shell.studioSetSetting(key, value) : host.setDeviceSetting(key, value)
      void Promise.resolve(write).catch((err: unknown) => rError('preferences', 'managed default not supplied', { key, error: String(err) }))
    }
    recordManagedDefaultValue(key, signature)
    rInfo('preferences', 'managed default supplied', { key })
  }
}

export function applyDeviceSettingsPolicy(store: PreferencesStore, policy: EnterprisePolicy | null): void {
  applySealedValues(store, policy)
  supplyManagedDefaults(store, policy)
}
