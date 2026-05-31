/**
 * Tests for the pure positioning math behind
 * `useAnchoredPopoverPosition`. The hook itself is a thin wrapper
 * around `computeAnchoredPosition` that wires up DOM measurement and
 * a re-measure deps list — the placement decisions live in the pure
 * function and are exercised here.
 *
 * Why test the pure function rather than the hook: vitest is
 * configured to run in node (no DOM). Adding jsdom + testing-library
 * for one hook would dwarf the implementation. The pure function
 * captures every branch the hook can produce (down-fits, flip-up,
 * clamp-top, horizontal clamp, submenu right-fits, submenu flip-left),
 * which is what the plan asked for.
 *
 * Each test uses a synthesized `menu` / `viewport` rather than a real
 * DOM so we can drive specific overflow scenarios deterministically.
 */

import { describe, it, expect } from 'vitest'
import { computeAnchoredPosition } from '../tabstrip-anchored-position'

// Reasonable defaults that match the hook's runtime defaults so the
// numbers in expectations stay aligned with what callers actually see.
const baseOpts = {
  offsetY: 8,
  offsetX: 8,
  margin: 8,
}

describe('computeAnchoredPosition', () => {
  describe('vertical (prefer: below)', () => {
    it('opens downward when the menu fits below the anchor', () => {
      const { left, top } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 100, y: 200 },
        menu: { width: 160, height: 200 },
        viewport: { width: 1200, height: 800 },
      })
      // 200 (anchor.y) + 8 (offsetY) = 208, well within the 800 vp.
      expect(top).toBe(208)
      expect(left).toBe(100)
    })

    it('flips upward when the menu would overflow the bottom', () => {
      // Anchor is near the bottom — opening downward would put the
      // bottom of the menu past `viewport.height`. Hook should flip
      // up so the menu sits above the anchor.
      const { top } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 100, y: 700 }, // near bottom
        menu: { width: 160, height: 300 }, // 700 + 8 + 300 = 1008 > 800 → overflow
        viewport: { width: 1200, height: 800 },
      })
      // Flip-up target: anchor.y - menuHeight - offsetY = 700 - 300 - 8 = 392.
      expect(top).toBe(392)
    })

    it('clamps to the top margin when the menu is taller than the viewport', () => {
      // Menu height > viewport — neither down-fits nor up-fits.
      // Should land at `margin` from top so at least the first few
      // items are visible and overflowY:auto can scroll the rest.
      const { top } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 100, y: 200 },
        menu: { width: 160, height: 1000 }, // bigger than 800
        viewport: { width: 1200, height: 800 },
      })
      expect(top).toBe(baseOpts.margin)
    })
  })

  describe('horizontal (prefer: below)', () => {
    it('anchors at anchor.x when there is room', () => {
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 100, y: 100 },
        menu: { width: 160, height: 100 },
        viewport: { width: 1200, height: 800 },
      })
      expect(left).toBe(100)
    })

    it('clamps the right edge inside the viewport', () => {
      // Anchor near the right edge — naive left=anchor.x would put
      // the menu off the right side. Should clamp to keep the
      // right edge inside.
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 1150, y: 100 },
        menu: { width: 200, height: 100 },
        viewport: { width: 1200, height: 800 },
      })
      // 1200 - 200 - 8 = 992 → clamp.
      expect(left).toBe(992)
    })
  })

  describe('vertical (prefer: rightOf, i.e. submenu)', () => {
    it('opens at anchor.y when it fits', () => {
      // Submenus don't use offsetY by default (the row's top *is*
      // where the user expects the submenu to start aligned).
      const { top } = computeAnchoredPosition({
        ...baseOpts,
        offsetY: 0,
        prefer: 'rightOf',
        anchor: { x: 200, y: 300 },
        menu: { width: 160, height: 200 },
        viewport: { width: 1200, height: 800 },
        parentRect: { left: 100, right: 200, top: 300, bottom: 320 },
      })
      expect(top).toBe(300)
    })

    it('flips up when the submenu would overflow the bottom', () => {
      const { top } = computeAnchoredPosition({
        ...baseOpts,
        offsetY: 0,
        prefer: 'rightOf',
        anchor: { x: 200, y: 700 },
        menu: { width: 160, height: 200 }, // 700 + 200 = 900 > 800
        viewport: { width: 1200, height: 800 },
        parentRect: { left: 100, right: 200, top: 700, bottom: 720 },
      })
      // Flip-up target: 700 - 200 - 0 = 500.
      expect(top).toBe(500)
    })
  })

  describe('horizontal (prefer: rightOf, i.e. submenu)', () => {
    it('opens to the right of the parent row when there is room', () => {
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'rightOf',
        anchor: { x: 200, y: 100 }, // anchor.x is parentRect.right
        menu: { width: 160, height: 200 },
        viewport: { width: 1200, height: 800 },
        parentRect: { left: 100, right: 200, top: 100, bottom: 120 },
      })
      // 200 (anchor.x) + 8 (offsetX) = 208, well within viewport.
      expect(left).toBe(208)
    })

    it('flips to the left of the parent row when the right side would overflow', () => {
      // Parent row near the right edge — opening to its right would
      // overflow. Hook should flip to the left of `parentRect.left`.
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'rightOf',
        anchor: { x: 1100, y: 100 }, // parentRect.right
        menu: { width: 200, height: 200 },
        viewport: { width: 1200, height: 800 },
        parentRect: { left: 1000, right: 1100, top: 100, bottom: 120 },
      })
      // Right-target: 1100 + 8 + 200 + 8 = 1316 > 1200 → flip.
      // Left-target: 1000 (parentLeft) - 200 (menuW) - 8 (offsetX) = 792.
      expect(left).toBe(792)
    })

    it('falls back to anchor-relative flip when no parentRect is provided', () => {
      // Without parentRect, the left-flip is computed from anchor.x
      // instead of parentRect.left. Same right-overflow scenario.
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'rightOf',
        anchor: { x: 1100, y: 100 },
        menu: { width: 200, height: 200 },
        viewport: { width: 1200, height: 800 },
      })
      // parentLeft fallback = anchor.x = 1100 → 1100 - 200 - 8 = 892.
      expect(left).toBe(892)
    })
  })

  describe('edge clamps', () => {
    it('never produces a top less than the margin', () => {
      // Anchor at y=0 with a small menu — the flip-up branch would
      // compute a negative `top`, so the final clamp must save us.
      const { top } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 100, y: 0 },
        menu: { width: 160, height: 100 },
        viewport: { width: 1200, height: 80 }, // forces down-overflow + tiny vp
      })
      expect(top).toBeGreaterThanOrEqual(baseOpts.margin - 1)
      // Specifically: with menu(100) > viewport(80), it falls to the
      // "clamp to top margin" branch.
      expect(top).toBe(baseOpts.margin)
    })

    it('never produces a left less than the margin', () => {
      // Anchor at x=0 with a menu wider than the viewport — clamp
      // should pin to the left margin rather than producing a
      // negative left.
      const { left } = computeAnchoredPosition({
        ...baseOpts,
        prefer: 'below',
        anchor: { x: 0, y: 100 },
        menu: { width: 2000, height: 100 },
        viewport: { width: 1200, height: 800 },
      })
      expect(left).toBe(baseOpts.margin)
    })
  })
})
