/**
 * Applies device policy's sealed settings to this client's preferences.
 *
 * A sealed setting with a value is shown and used, in memory only. What the
 * person saved stays on disk, so it is back when the seal lifts.
 *
 * A policy value whose shape does not match the preference it names is not
 * applied. The key stays refused to writers either way.
 */
import type { StoreApi, UseBoundStore } from 'zustand'
import { sealedSettingValues, stableStringify } from '@ion/shared/enterprise-settings-policy'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { PreferencesState } from '@ion/server/preferences-types'
import { rInfo, rWarn } from './rendererLogger'

type PreferencesStore = UseBoundStore<StoreApi<PreferencesState>>

/** True when `value` could stand where `current` is: same primitive type, or both lists, or both records. */
export function sameShape(current: unknown, value: unknown): boolean {
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

export function applyDeviceSettingsPolicy(store: PreferencesStore, policy: EnterprisePolicy | null): void {
  applySealedValues(store, policy)
}
