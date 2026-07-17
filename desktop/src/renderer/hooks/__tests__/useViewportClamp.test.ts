import { describe, it, expect } from 'vitest'
import { clampDelta } from '../useViewportClamp'

function rect(left: number, top: number, w: number, h: number): DOMRect {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h } as DOMRect
}

describe('clampDelta', () => {
  it('inside the viewport: no correction', () => {
    expect(clampDelta(rect(100, 100, 200, 150), 1000, 800)).toEqual({ dx: 0, dy: 0 })
  })
  it('clipped top (overlay-style popover above a top-anchored strip)', () => {
    expect(clampDelta(rect(100, -120, 200, 150), 1000, 800)).toEqual({ dx: 0, dy: 128 })
  })
  it('clipped right and bottom', () => {
    const d = clampDelta(rect(900, 700, 200, 150), 1000, 800)
    expect(d.dx).toBe(1000 - 8 - 1100)
    expect(d.dy).toBe(800 - 8 - 850)
  })
  it('taller than the viewport: pins to the top edge', () => {
    const d = clampDelta(rect(10, 100, 100, 900), 1000, 800)
    expect(d.dy).toBe(8 - 100) // top wins after bottom correction
  })
})
