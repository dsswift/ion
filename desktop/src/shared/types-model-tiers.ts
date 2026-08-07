/** One named model-selection tier from the engine's complete snapshot. */
export interface ModelTier {
  name: string
  model: string
  fallbacks: string[]
}

/** Built-in tier names with stable product meanings. */
export const STANDARD_TIERS = ['reasoning', 'standard', 'fast'] as const
export type StandardTierName = typeof STANDARD_TIERS[number]

/** Tier used by bounded mechanical conflict-resolution assistance. */
export const CONFLICT_ASSIST_TIER = 'standard' satisfies StandardTierName
