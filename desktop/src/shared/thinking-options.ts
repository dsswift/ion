import type { ThinkingEffort } from './types-session'

/**
 * thinking-options — the per-model menu of thinking choices.
 *
 * A model's `thinkingMode` decides which choices are HONEST for it, and the
 * two families differ in a way that matters:
 *
 *   adaptive (Anthropic) — the model reasons on its own whether or not the
 *     client asks. There is no real "off": with no directive the engine still
 *     sends a display-only adaptive block so the reasoning it performs anyway
 *     stays observable. Offering "Off" would be a lie, so `Adaptive` takes its
 *     place as the default and means "you choose the depth". Picking an
 *     explicit level pins the depth and OVERRIDES the model's per-turn
 *     judgment — legitimate on a hard problem, wrong as a default, because it
 *     forces maximum reasoning on trivial turns too.
 *
 *   reasoning_effort / gemini / budget — the level IS the mechanism. There is
 *     no self-regulation to defer to, so `Off` is meaningful and an explicit
 *     level is the normal way to use them.
 *
 * Shared rather than duplicated in the picker because iOS renders the same
 * control from the same model metadata; a second copy of this rule would drift.
 */

/** One selectable row in the thinking control. */
export interface ThinkingOption {
  value: ThinkingEffort
  label: string
}

/** Model capability modes the engine can report (types.ModelInfo.ThinkingMode). */
export const ADAPTIVE_THINKING_MODE = 'adaptive'

/**
 * The options to offer for a model with the given `thinkingMode`, in display
 * order. The FIRST entry is that mode's default/neutral choice.
 *
 * `allowedEfforts` is the model's advertised `thinkingEfforts` list; levels
 * outside it are omitted, because the engine rejects an effort a model did not
 * advertise (see providers.resolveThinking) and offering it would produce a
 * control that silently does nothing.
 */
export function thinkingOptionsForMode(
  thinkingMode: string | undefined,
  allowedEfforts: readonly string[] = [],
): ThinkingOption[] {
  // Ascending ladder. Only the rungs a model advertises are offered — the
  // engine rejects an effort outside the model's ThinkingEfforts, so an
  // unadvertised level would render a control that silently does nothing.
  const levels: ThinkingOption[] = ([
    { value: 'low', label: thinkingEffortLabel('low') },
    { value: 'medium', label: thinkingEffortLabel('medium') },
    { value: 'high', label: thinkingEffortLabel('high') },
    { value: 'xhigh', label: thinkingEffortLabel('xhigh') },
    { value: 'max', label: thinkingEffortLabel('max') },
  ] as ThinkingOption[]).filter((l) => allowedEfforts.includes(l.value))

  const neutral: ThinkingOption = thinkingMode === ADAPTIVE_THINKING_MODE
    ? { value: 'adaptive', label: thinkingEffortLabel('adaptive') }
    : { value: 'off', label: thinkingEffortLabel('off') }

  return [neutral, ...levels]
}

/**
 * The default effort for a model with the given `thinkingMode`.
 *
 * Adaptive models default to `adaptive` (self-regulated depth). Everything
 * else defaults to the user's configured preference, which the caller supplies
 * — for effort-based models the level is the only way to get reasoning at all.
 */
export function defaultEffortForMode(
  thinkingMode: string | undefined,
  configuredDefault: ThinkingEffort,
): ThinkingEffort {
  if (thinkingMode === ADAPTIVE_THINKING_MODE) return 'adaptive'
  return configuredDefault
}

/**
 * Whether `effort` is selectable for a model with this mode. Used to repair a
 * stored value when the conversation's model changes underneath it — e.g. an
 * instance holding `adaptive` after switching to an effort-based model, which
 * the engine would reject as an unadvertised effort.
 */
export function isEffortValidForMode(
  effort: ThinkingEffort,
  thinkingMode: string | undefined,
  allowedEfforts: readonly string[] = [],
): boolean {
  return thinkingOptionsForMode(thinkingMode, allowedEfforts).some((o) => o.value === effort)
}

/**
 * Repair a possibly-stale stored effort against the model actually in use.
 *
 * The stored per-conversation effort outlives a model change. A conversation
 * seeded `adaptive` on a Claude model keeps that value when the user switches
 * to an effort-based model, where `adaptive` is not a selectable option — and
 * the engine maps it to an EMPTY effort, so `resolveThinking` drops the
 * directive and the user silently gets NO reasoning on a model where the level
 * is the only way to get any. The mirror case (`off` on an adaptive model) is
 * merely cosmetic but equally wrong to display.
 *
 * Returns the stored value when it is valid for this model, otherwise the
 * model's neutral entry. Used by both the picker (display) and the send path
 * (wire), so what the user sees and what the engine receives agree.
 */
export function resolveEffortForModel(
  stored: ThinkingEffort,
  thinkingMode: string | undefined,
  allowedEfforts: readonly string[] = [],
): ThinkingEffort {
  // Only repair when the model's capabilities are actually KNOWN. Model
  // metadata arrives asynchronously (registry load, discovery), and an unknown
  // model advertises no efforts — repairing against that empty set would
  // discard a perfectly valid stored level and silently turn thinking off for
  // any prompt sent before the registry populates. When we know nothing, the
  // stored value is the best information available; the engine's own
  // capability resolver is the backstop that drops an unsupported effort.
  if (allowedEfforts.length === 0) return stored
  if (isEffortValidForMode(stored, thinkingMode, allowedEfforts)) return stored
  const opts = thinkingOptionsForMode(thinkingMode, allowedEfforts)
  return opts[0]?.value ?? 'off'
}

/**
 * Every value the thinking control may carry, in ascending order after the two
 * sentinels. Single source of truth for runtime validation, so a validator
 * cannot silently fall behind the `ThinkingEffort` union — which is exactly how
 * `adaptive` came to be rejected by the iOS command handler while the type
 * accepted it everywhere else.
 */
export const THINKING_EFFORT_VALUES: readonly ThinkingEffort[] = [
  'off',
  'adaptive',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** Runtime type guard for an untrusted effort value (wire input, settings file). */
export function isThinkingEffort(v: unknown): v is ThinkingEffort {
  return typeof v === 'string' && (THINKING_EFFORT_VALUES as readonly string[]).includes(v)
}

/**
 * Display label for a single effort value. Shared so the settings picker, the
 * status-bar control, and the iOS menu render the same words — plain
 * capitalization would produce "Xhigh".
 */
export function thinkingEffortLabel(effort: ThinkingEffort): string {
  switch (effort) {
    case 'off': return 'Off'
    case 'adaptive': return 'Adaptive'
    case 'low': return 'Low'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'xhigh': return 'Extra High'
    case 'max': return 'Max'
  }
}
