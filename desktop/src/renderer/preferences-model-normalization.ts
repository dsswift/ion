import type { ModelEntry } from '../shared/types-models'
import { normalizeModelPreferences } from '../shared/model-identity'
import { rWarn } from './rendererLogger'
import { getAllSettings, saveSettings } from './preferences-persist'
import type { PreferencesState } from './preferences-types'

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
  saveSettings(getAllSettings(get))
}
