import type { AutomationCausation } from './types'

export type CausationDecision =
  | { ok: true; causation: AutomationCausation }
  | { ok: false; reason: 'cycle' | 'max-depth' }

/** Default ceiling permits useful fan-out while making recursive event loops finite. */
export const DEFAULT_MAX_AUTOMATION_DEPTH = 8

/**
 * Derive causation for one automation execution. Re-entering an identifier in
 * the same chain is refused exactly, rather than guessed from event timing.
 */
export function continueAutomationCausation(
  parent: AutomationCausation,
  automationId: string,
  maxDepth: number = DEFAULT_MAX_AUTOMATION_DEPTH,
): CausationDecision {
  const chain = parent.chain
  if (chain.includes(automationId)) return { ok: false, reason: 'cycle' }
  if (chain.length >= maxDepth) return { ok: false, reason: 'max-depth' }
  return {
    ok: true,
    causation: {
      rootId: parent.rootId,
      chain: [...chain, automationId],
      depth: chain.length + 1,
    },
  }
}
