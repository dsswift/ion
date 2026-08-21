/**
 * Client-side context-capacity policy.
 *
 * The engine supplies `contextTokens`, the current in-window occupancy. Clients
 * divide it by the selected model's effective context limit. Durable transcript
 * bytes and itemized context-breakdown totals are not capacity signals.
 */
export interface ContextCapacity {
  occupancyTokens: number
  limitTokens: number
  percent: number
}

export type ContextCapacityState = 'normal' | 'warning' | 'full'

export const DEFAULT_CONTEXT_OUTPUT_RESERVE = 20_000
export const CONTEXT_SUMMARY_RESERVE = 13_000

/**
 * Usable input capacity for the selected model. The reserve mirrors the engine
 * default when model metadata has no output cap. The engine-reported limit is a
 * fallback only when the selected model itself is unknown.
 */
export function selectedModelContextLimit(rawWindow: number, maxOutputTokens?: number | null): number | null {
  if (rawWindow <= 0) return null
  return Math.max(1, rawWindow - (maxOutputTokens && maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_CONTEXT_OUTPUT_RESERVE) - CONTEXT_SUMMARY_RESERVE)
}

export function resolveContextCapacity(
  occupancyTokens: number | null | undefined,
  limitTokens: number | null | undefined,
): ContextCapacity | null {
  if (!occupancyTokens || occupancyTokens <= 0 || !limitTokens || limitTokens <= 0) return null
  return {
    occupancyTokens,
    limitTokens,
    percent: (occupancyTokens / limitTokens) * 100,
  }
}

export function contextCapacityState(capacity: ContextCapacity | null | undefined): ContextCapacityState {
  if (!capacity || capacity.percent < 80) return 'normal'
  return capacity.percent >= 100 ? 'full' : 'warning'
}

/** `/compact` and `/clear` reduce or replace the full context, so they remain usable at capacity. */
export function isContextRecoveryCommand(text: string): boolean {
  return /^\s*\/(?:compact|clear)(?:\s|$)/i.test(text)
}

export function contextCapacityBlocksPrompt(
  capacity: ContextCapacity | null | undefined,
  text: string,
): boolean {
  return contextCapacityState(capacity) === 'full' && !isContextRecoveryCommand(text)
}
