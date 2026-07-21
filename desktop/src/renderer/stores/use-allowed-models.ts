import { usePreferencesStore } from '../preferences'
import { getFilteredModels, type AvailableModel } from './model-labels'

/**
 * Reactive hook: the model list filtered by the current enterprise policy
 * (D-011). Reads enterprisePolicy.allowedModels from the preferences store
 * (populated from the engine's get_enterprise_policy blob at startup).
 * Returns the full AVAILABLE_MODELS list when no enterprise policy is active.
 *
 * Lives in its own module (not model-labels.ts) so the pure filter stays
 * importable without dragging in the preferences store's module-load side
 * effects (theme application, settings hydration).
 */
export function useAllowedModels(): readonly AvailableModel[] {
  const allowedModels = usePreferencesStore((s) => s.enterprisePolicy?.allowedModels)
  return getFilteredModels(allowedModels)
}
