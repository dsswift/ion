import { describe, expect, it } from 'vitest'
import { resolveOverlayBodyHeights } from './overlay-body-height'

describe('resolveOverlayBodyHeights', () => {
  it('keeps normal conversation and terminal bodies inside a scaled viewport', () => {
    const result = resolveOverlayBodyHeights(520, 110, true)
    expect(result.terminal + result.conversation + 110 + 70).toBeLessThanOrEqual(520)
  })

  it('keeps a normal conversation body usable in a short viewport', () => {
    expect(resolveOverlayBodyHeights(240, 110, false).conversation).toBeGreaterThanOrEqual(96)
  })
})
