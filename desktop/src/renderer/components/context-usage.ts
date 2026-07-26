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
