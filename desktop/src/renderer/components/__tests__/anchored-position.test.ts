/**
 * computeAnchoredPosition — pure positioning math for anchored popovers.
 *
 * No DOM, no React, no theme. These tests pin the flip/clamp behavior that
 * useAnchoredPopover relies on, ensuring popovers stay inside the viewport.
 */
import { describe, it, expect } from 'vitest'
import { computeAnchoredPosition, type AnchoredPositionInput } from '../anchored-position'

const VIEWPORT = { width: 800, height: 600 }
const MENU = { width: 200, height: 150 }
const MARGIN = 8

function pos(overrides: Partial<AnchoredPositionInput> = {}): { left: number; top: number } {
  return computeAnchoredPosition({
    anchor: { x: 100, y: 100 },
    menu: MENU,
    viewport: VIEWPORT,
    offsetY: 4,
    offsetX: 4,
    margin: MARGIN,
    prefer: 'below',
    ...overrides,
  })
}

describe('prefer: below', () => {
  it('opens below the anchor when space is available', () => {
    const result = pos()
    expect(result.top).toBe(104)
    expect(result.left).toBe(100)
  })

  it('flips upward when bottom overflows', () => {
    const result = pos({ anchor: { x: 100, y: 500 } })
    expect(result.top).toBe(500 - MENU.height - 4)
  })

  it('pins to top margin when menu is taller than available space', () => {
    const result = pos({ menu: { width: 200, height: 590 } })
    expect(result.top).toBe(MARGIN)
  })

  it('clamps left edge to margin', () => {
    const result = pos({ anchor: { x: 2, y: 100 } })
    expect(result.left).toBe(MARGIN)
  })

  it('clamps right edge inside viewport', () => {
    const result = pos({ anchor: { x: 700, y: 100 } })
    expect(result.left).toBeLessThanOrEqual(VIEWPORT.width - MENU.width - MARGIN)
  })

  it('handles anchor at viewport origin', () => {
    const result = pos({ anchor: { x: 0, y: 0 } })
    expect(result.left).toBe(MARGIN)
    expect(result.top).toBe(MARGIN)
  })

  it('handles anchor at viewport bottom-right corner', () => {
    const result = pos({ anchor: { x: 800, y: 600 } })
    expect(result.left).toBeLessThanOrEqual(VIEWPORT.width - MENU.width - MARGIN)
    expect(result.top).toBeLessThanOrEqual(VIEWPORT.height - MENU.height - MARGIN)
  })
})

describe('prefer: rightOf', () => {
  const parentRect = { left: 80, right: 280, top: 100, bottom: 130 }

  it('opens to the right of the parent when space is available', () => {
    const result = pos({
      prefer: 'rightOf',
      anchor: { x: 280, y: 100 },
      parentRect,
    })
    expect(result.left).toBe(284)
    expect(result.top).toBe(100)
  })

  it('flips to the left of the parent when right overflows', () => {
    const result = pos({
      prefer: 'rightOf',
      anchor: { x: 650, y: 100 },
      parentRect: { left: 430, right: 650, top: 100, bottom: 130 },
    })
    expect(result.left).toBe(430 - MENU.width - 4)
  })

  it('uses anchor.x as fallback when parentRect is absent', () => {
    const result = pos({
      prefer: 'rightOf',
      anchor: { x: 280, y: 100 },
    })
    expect(result.left).toBe(284)
  })

  it('still flips vertically when bottom overflows', () => {
    const result = pos({
      prefer: 'rightOf',
      anchor: { x: 280, y: 500 },
      parentRect,
    })
    expect(result.top).toBeLessThanOrEqual(VIEWPORT.height - MENU.height - MARGIN)
  })
})

describe('edge cases', () => {
  it('handles zero-size viewport by pinning to margin', () => {
    const result = pos({ viewport: { width: 50, height: 50 } })
    expect(result.left).toBe(MARGIN)
    expect(result.top).toBe(MARGIN)
  })

  it('handles menu larger than viewport', () => {
    const result = pos({ menu: { width: 900, height: 700 } })
    expect(result.left).toBe(MARGIN)
    expect(result.top).toBe(MARGIN)
  })

  it('respects custom offsetY', () => {
    const result = pos({ offsetY: 20 })
    expect(result.top).toBe(120)
  })

  it('respects custom offsetX for rightOf', () => {
    const result = pos({
      prefer: 'rightOf',
      offsetX: 10,
      anchor: { x: 280, y: 100 },
    })
    expect(result.left).toBe(290)
  })

  it('respects custom margin', () => {
    const result = pos({ margin: 20, anchor: { x: 5, y: 100 } })
    expect(result.left).toBe(20)
  })
})
