/** One named model-selection tier from the engine's complete snapshot. */
export interface ModelTier {
  name: string
  model: string
  fallbacks: string[]
}

/** Desktop-managed tier names with stable product meanings. */
export const WORKBENCH_SYNC_TIER = 'workbench-sync' as const
export const STANDARD_TIERS = ['reasoning', 'standard', 'fast', WORKBENCH_SYNC_TIER] as const
export type StandardTierName = typeof STANDARD_TIERS[number]

/** Fallback tier when workbench-sync has no explicit model. */
export const CONFLICT_ASSIST_TIER = 'standard' satisfies StandardTierName
