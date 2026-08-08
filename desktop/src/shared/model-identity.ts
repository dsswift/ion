import type { ModelEntry } from './types-models'

/** One model choice with routing-safe value and human-visible identity. */
export interface ModelChoice {
  value: string
  label: string
  providerId: string
  modelId: string
}

/**
 * Group live entries for pickers. Values are engine-advertised model IDs
 * (already qualified by the engine when a collision or gateway alias exists).
 */
export function groupModelChoices(models: Array<Pick<ModelEntry, 'id' | 'providerId'>>): Map<string, ModelChoice[]> {
  const groups = new Map<string, ModelChoice[]>()
  for (const model of models) {
    const entry: ModelChoice = {
      value: model.id,
      label: model.id,
      providerId: model.providerId,
      modelId: model.id,
    }
    const group = groups.get(model.providerId) ?? []
    group.push(entry)
    groups.set(model.providerId, group)
  }
  return groups
}

/** Return live entry matching a persisted model identity. */
export function findModelEntry(modelId: string, models: ModelEntry[]): ModelEntry | undefined {
  return models.find((model) => model.id === modelId)
}

/** Visible identity. Shows "(unavailable)" when not in the live model set. */
export function modelIdentityLabel(modelId: string, models: ModelEntry[] = []): string {
  return findModelEntry(modelId, models) ? modelId : `${modelId} (unavailable)`
}

/** Backward-compatible name for model-picker label resolution. */
export const resolveModelDisplayLabel = modelIdentityLabel

/**
 * Normalize a legacy provider-qualified preference to the engine's canonical
 * bare ID when the qualified form no longer matches any live model but the
 * bare suffix does. Ambiguous matches (multiple providers with the same bare
 * ID) preserve the stored value so the user's routing intent is not lost.
 */
export function resolveLegacyModelId(modelId: string, models: ModelEntry[]): string {
  if (!modelId) return modelId
  if (models.some((model) => model.id === modelId)) return modelId
  if (!modelId.includes('/')) return modelId
  const bare = modelId.slice(modelId.indexOf('/') + 1)
  const matches = models.filter((model) => model.id === bare)
  return matches.length === 1 ? bare : modelId
}

export interface ModelPreferenceValues {
  preferredModel: string
  engineDefaultModel: string
  planModeModel: string
  implementModeModel: string
}

/** Normalize all persisted desktop model preferences from one model snapshot. */
export function normalizeModelPreferences(values: ModelPreferenceValues, models: ModelEntry[]): ModelPreferenceValues {
  return {
    preferredModel: resolveLegacyModelId(values.preferredModel, models),
    engineDefaultModel: resolveLegacyModelId(values.engineDefaultModel, models),
    planModeModel: resolveLegacyModelId(values.planModeModel, models),
    implementModeModel: resolveLegacyModelId(values.implementModeModel, models),
  }
}
