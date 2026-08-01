/**
 * Pure context-usage arithmetic, shared by the status bar, the radial ring,
 * and the status drawer.
 *
 * Kept free of React, theme, and store imports so every consumer resolves the
 * same numbers from the same code and the tests can exercise the shipped
 * functions directly. The previous test file re-implemented this math locally
 * behind a "kept in lockstep" comment, which meant a drift between component
 * and test was invisible.
 */

/** Resolved context display state. */
export interface ContextDisplay {
  /** True occupancy percentage. UNBOUNDED — may exceed 100. */
  pct: number
  tokens: number
  windowSize: number
}

/**
 * The minimum shape `resolveContextInputs` reads off a conversation instance.
 *
 * Declared structurally rather than importing `ConversationInstance` so this
 * module stays free of store imports (see the file header) — any object with
 * these fields works, which is also what lets the tests pass plain literals.
 */
export interface ContextInstanceLike {
  contextBreakdown?: { occupancyTokens?: number; totalTokens?: number } | null
  statusFields?: { contextTokens?: number; contextWindow?: number } | null
}

/** The two engine-derived numbers every context surface needs. */
export interface ContextInputs {
  /** Occupancy numerator, or null when the engine has reported none. */
  tokens: number | null
  /** Engine-reported window for the model it actually ran, or null. */
  engineWindow: number | null
}

/**
 * Resolve the numerator and the engine-window fallback for a context surface.
 *
 * Both the status-bar ring and the status drawer call this, so the two cannot
 * read different fields or order them differently. Assembling these by hand at
 * each call site is what let the numerator and the denominator drift apart
 * independently — the numerator agreed by construction while the denominator was
 * still a per-call-site argument.
 *
 * Numerator priority — occupancy arrives on two paths carrying the SAME value,
 * because the engine derives both from one `GetContextUsage` call:
 *
 *   1. `contextBreakdown.occupancyTokens` — published on every breakdown
 *      emission. Preferred because a breakdown is present even for an idle
 *      conversation whose `statusFields` have not been seeded.
 *   2. `statusFields.contextTokens` — the streaming status path.
 *
 * `contextBreakdown.totalTokens` is deliberately NOT a candidate. It is the
 * engine's ITEMIZED per-category estimate, meant for attribution ("what is
 * taking up the space"), and it over-reports because it counts content the
 * provider did not bill for this turn. Reading it as occupancy rendered a
 * conversation occupying 26% of a 1M window as 103%.
 *
 * `engineWindow` is the window the engine reported for the model it actually
 * ran. It is a *fallback* denominator, consulted by `getDynamicContextWindow`
 * only when neither the dynamic model store nor the static catalog knows the
 * selected model — never an override of the picker's selection.
 */
export function resolveContextInputs(inst: ContextInstanceLike | null | undefined): ContextInputs {
  return {
    tokens: inst?.contextBreakdown?.occupancyTokens
      ?? inst?.statusFields?.contextTokens
      ?? null,
    engineWindow: inst?.statusFields?.contextWindow ?? null,
  }
}

/**
 * Divide engine-reported occupancy by the SELECTED model's window.
 *
 * Why the selected model and not the engine's: there is no engine command to
 * change an idle session's model (the model changes only at the next prompt
 * dispatch), so the picker-driven recompute is necessarily client-side
 * arithmetic. Switching a 220k-token conversation from a 1M model to a 100k
 * one must immediately read 220%, and only local division can do that.
 *
 * The result is deliberately NOT capped at 100. Over-budget is real
 * information — an operator at 220% needs to see 220%, not a number that
 * looks identical to exactly-full. Callers clamp for geometry only.
 */
export function resolveContextDisplay(tokens: number | null, windowSize: number): ContextDisplay | null {
  if (tokens === null || tokens <= 0 || windowSize <= 0) return null
  return {
    pct: Math.round((tokens / windowSize) * 100),
    tokens,
    windowSize,
  }
}

/** Format a token count for the tooltip: 1.2M / 227k. */
export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

/* ─── Radial geometry ─── */

/**
 * A 24-unit viewBox with r=9.75 and a 3-unit stroke puts the outer edge at
 * 11.25 and the inner at 8.25, so the stroke fits the box with no clipping at
 * any render size.
 */
export const RADIAL_RADIUS = 9.75
export const RADIAL_CIRCUMFERENCE = 2 * Math.PI * RADIAL_RADIUS

/**
 * Dash offset for a given percentage.
 *
 * The percentage is clamped to 0-100 HERE and only here: a ring physically
 * cannot draw 220% of itself, so an over-budget conversation renders as a
 * full ring in the danger color. The true uncapped figure is what the
 * tooltip, the aria-label, and the status drawer report — the clamp is a
 * geometry constraint, never a truth constraint.
 */
export function radialDashOffset(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct))
  return RADIAL_CIRCUMFERENCE - (clamped / 100) * RADIAL_CIRCUMFERENCE
}

/**
 * Threshold key for a given percentage. Returned as a semantic key rather
 * than a color so this stays a pure function (colors are theme-dependent).
 */
export function radialLevel(pct: number): 'normal' | 'warning' | 'danger' {
  if (pct >= 80) return 'danger'
  if (pct >= 60) return 'warning'
  return 'normal'
}
