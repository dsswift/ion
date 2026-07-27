/**
 * Tests for the context radial's geometry and threshold selection.
 *
 * The ring replaced the `65%` text readout in the status bar, so the
 * percentage is no longer rendered as text anywhere — the arc length and the
 * accessible name are the entire signal, which makes both worth pinning.
 */

import { describe, it, expect } from 'vitest'
import { radialDashOffset, radialLevel, RADIAL_CIRCUMFERENCE } from '../context-usage'

describe('radialDashOffset', () => {
  it('draws no arc at 0%', () => {
    expect(radialDashOffset(0)).toBeCloseTo(RADIAL_CIRCUMFERENCE, 5)
  })

  it('draws half the ring at 50%', () => {
    expect(radialDashOffset(50)).toBeCloseTo(RADIAL_CIRCUMFERENCE / 2, 5)
  })

  it('closes the ring at 100%', () => {
    expect(radialDashOffset(100)).toBeCloseTo(0, 5)
  })

  it('clamps the GEOMETRY at 100% for an over-budget conversation', () => {
    // A ring cannot draw 220% of itself, so the arc saturates — but this is
    // the only place the clamp applies. The tooltip and aria-label carry the
    // true uncapped figure (see StatusBarContextIndicator).
    expect(radialDashOffset(220)).toBeCloseTo(0, 5)
  })

  it('clamps a negative input to an empty ring', () => {
    expect(radialDashOffset(-10)).toBeCloseTo(RADIAL_CIRCUMFERENCE, 5)
  })
})

describe('radialLevel', () => {
  it('is normal below 60%', () => {
    expect(radialLevel(0)).toBe('normal')
    expect(radialLevel(59)).toBe('normal')
  })

  it('warns from 60%', () => {
    expect(radialLevel(60)).toBe('warning')
    expect(radialLevel(79)).toBe('warning')
  })

  it('is danger from 80%', () => {
    expect(radialLevel(80)).toBe('danger')
    expect(radialLevel(100)).toBe('danger')
  })

  it('stays danger when over budget', () => {
    expect(radialLevel(220)).toBe('danger')
  })
})
