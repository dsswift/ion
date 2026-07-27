/**
 * Tests for the status-bar context indicator's resolution math.
 *
 * These import `resolveContextDisplay` from the component module rather than
 * re-implementing the formula. The previous version of this file carried a
 * local copy behind a "kept in lockstep with the component" comment, which
 * meant a drift between the two was invisible — the tests could stay green
 * while the shipped arithmetic changed underneath them. Testing the exported
 * function is what makes these assertions load-bearing.
 */

import { describe, it, expect } from 'vitest'
import { resolveContextDisplay, formatTokens } from '../context-usage'

describe('resolveContextDisplay', () => {
  it('reports occupancy for an idle conversation with no live run', () => {
    // The reported bug: conversation 1785027902573-51e1d86f06cb held ~223k
    // tokens against a 1M window and the status bar rendered 0%, because the
    // indicator preferred a cumulative-billing figure over the engine's
    // occupancy. There is now one numerator and no live-vs-idle inversion.
    const out = resolveContextDisplay(223_791, 1_000_000)
    expect(out).not.toBeNull()
    expect(out!.pct).toBe(22)
    expect(out!.tokens).toBe(223_791)
  })

  it('recomputes when the model changes — 1M to 200k', () => {
    // No engine command can change an idle session's model, so the picker
    // recompute must be pure client-side division. Same tokens, smaller
    // window, bigger percentage.
    const onOpus = resolveContextDisplay(220_000, 1_000_000)
    const onSonnet = resolveContextDisplay(220_000, 200_000)
    expect(onOpus!.pct).toBe(22)
    expect(onSonnet!.pct).toBe(110)
  })

  it('is uncapped — 220k on a 100k window reads 220%', () => {
    // Over-budget is real information. Clamping at 100 made an over-budget
    // conversation indistinguishable from an exactly-full one.
    const out = resolveContextDisplay(220_000, 100_000)
    expect(out!.pct).toBe(220)
  })

  it('returns null when there is no occupancy figure yet', () => {
    expect(resolveContextDisplay(null, 200_000)).toBeNull()
    expect(resolveContextDisplay(0, 200_000)).toBeNull()
  })

  it('returns null rather than dividing by a zero window', () => {
    expect(resolveContextDisplay(100_000, 0)).toBeNull()
  })

  it('rounds to the nearest whole percent', () => {
    expect(resolveContextDisplay(1_500, 100_000)!.pct).toBe(2)
    expect(resolveContextDisplay(1_400, 100_000)!.pct).toBe(1)
  })
})

describe('formatTokens', () => {
  it('renders sub-million counts in k', () => {
    expect(formatTokens(223_791)).toBe('224k')
    expect(formatTokens(200_000)).toBe('200k')
  })

  it('renders million-plus counts in M', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
})
