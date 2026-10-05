// A plan-mode change a before_plan_mode_* handler refused, as a conversation
// keeps it. Re-exported from types-engine.ts.

/** A vetoed plan-mode change, from engine_plan_mode_change_rejected. */
export interface PlanModeRejection {
  /** The mode that was asked for: true for plan, false for auto. */
  requestedEnabled: boolean
  /** The handler's explanation; may be empty. */
  reason: string
  /** "wire" (a client toggle) or "extension". */
  source: string
  /** Epoch ms when the rejection arrived. */
  at: number
}
