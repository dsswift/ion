import { describe, it, expect } from 'vitest'
import { clampDelta } from '../viewport-clamp-math'

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

  // ── UI zoom ──
  //
  // The overflow math runs in viewport pixels; the delta is applied as a CSS
  // length inside a zoomed root, which scales it again. These cases pin the
  // division that cancels the second scaling.
  it('zoom 1: correction is the raw viewport delta', () => {
    expect(clampDelta(rect(900, 700, 200, 150), 1000, 800, 1))
      .toEqual(clampDelta(rect(900, 700, 200, 150), 1000, 800))
  })
  it('zoom 2: halves the correction so the applied CSS length lands right', () => {
    const d = clampDelta(rect(900, 700, 200, 150), 1000, 800, 2)
    expect(d.dx).toBe((1000 - 8 - 1100) / 2)
    expect(d.dy).toBe((800 - 8 - 850) / 2)
  })
  it('zoom 0.5: doubles the correction', () => {
    const d = clampDelta(rect(100, -120, 200, 150), 1000, 800, 0.5)
    expect(d.dy).toBe(128 / 0.5)
  })
  it('non-positive zoom falls back to 1 rather than dividing by zero', () => {
    const d = clampDelta(rect(100, -120, 200, 150), 1000, 800, 0)
    expect(d.dy).toBe(128)
  })
})
