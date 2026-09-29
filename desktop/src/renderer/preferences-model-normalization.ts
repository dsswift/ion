import type { ModelEntry } from '@ion/shared/types-models'
import { normalizeModelPreferences } from '@ion/shared/model-identity'
import { rWarn } from './rendererLogger'
import { saveSettingsFor } from './preferences-persist'
import type { PreferencesState } from '@ion/server/preferences-types'

export function normalizePreferencesModels(
  set: (partial: Partial<PreferencesState>) => void,
  get: () => PreferencesState,
  models: ModelEntry[],
): void {
  const current = get()
  const next = normalizeModelPreferences({
    preferredModel: current.preferredModel,
    engineDefaultModel: current.engineDefaultModel,
    planModeModel: current.planModeModel,
    implementModeModel: current.implementModeModel,
  }, models)
  const changed = Object.entries(next).filter(([key, value]) => current[key as keyof typeof next] !== value)
  if (changed.length === 0) return
  set(next)
  rWarn('preferences', 'legacy model preferences normalized to engine-canonical IDs', {
    fields: changed.map(([key]) => key).join(','),
  })
  // Only the model-preference fields this function itself computed -- never
  // the full snapshot, which would freeze every other in-memory field into
  // this identity's overlay too. See persist()'s doc comment.
  // To the server THIS store is bound to: these are Account settings, and a
  // store built for another server must never write them to the local one.
  saveSettingsFor(set, { ...next })
}
