import type { ThinkingEffort } from '../../shared/types-session'
import { thinkingOptionsForMode } from '../../shared/thinking-options'

/* ─── Thinking Control State Resolver ─── */

/**
 * Resolves how the per-conversation thinking control should render for a given
 * model. Pure — no React, no store, no color tokens — so the rendering rules
 * are unit-testable without mounting anything.
 *
 * The `thinkingEffort` wire values are unchanged. Their neutral value is
 * model-dependent: `adaptive` for adaptive models, `off` otherwise. What that
 * resolves to is a property of the model, which is why it needs resolving:
 *
 *  - `thinkingMode === 'adaptive'`: the model always thinks, at its own default
 *    budget, and cannot be turned off. The neutral row therefore reads
 *    "Adaptive" — it is what the model does with no override, not an absence of
 *    thinking. Advertised override levels are layered on top of that floor. "Adaptive" REPLACES "Off" for these models; it is not a fifth entry.
 *  - any other mode that declares effort levels: the neutral row reads "Off".
 *  - a model that declares no effort levels: the control renders DISABLED.
 *    Never hidden — a control that vanishes teaches the user nothing about why
 *    the option is unavailable, and it makes the status bar reflow between
 *    models.
 *
 * The iOS counterpart is `ios/IonRemote/Views/ThinkingControlState.swift` and
 * carries the same three outputs. Changes here belong there too.
 */

/** The visible label and selectable rows for one model's thinking control. */
export interface ThinkingControlState {
  /** Neutral trigger label when stored effort is not selectable for this model. */
  offLabel: string
  /** Model-supported choices in display order. */
  levels: Array<{ value: ThinkingEffort; label: string }>
  /** False when model declares no configurable effort levels. */
  enabled: boolean
}

/**
 * Resolve the control's rendering state from the model's declared reasoning
 * shape. The offered rows come from the shared model-capability resolver so
 * this display helper cannot drift from submit-time effort validation.
 */
export function resolveThinkingControlState(
  thinkingMode: string | undefined,
  thinkingEfforts: string[] | undefined,
): ThinkingControlState {
  const declared = thinkingEfforts ?? []
  const levels = thinkingOptionsForMode(thinkingMode, declared)
  return {
    offLabel: levels[0]?.label ?? 'Off',
    levels,
    enabled: declared.length > 0,
  }
}

/** Label for the trigger given the currently-selected effort. */
export function thinkingTriggerLabel(state: ThinkingControlState, effort: ThinkingEffort): string {
  return state.levels.find((l) => l.value === effort)?.label ?? state.offLabel
}
