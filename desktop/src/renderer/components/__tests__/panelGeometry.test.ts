/**
 * panelGeometry — the derived height clamp and the single-source width.
 *
 * ── The width defect these pin ──────────────────────────────────────────────
 * The git panel's width was declared three times and the three disagreed: the
 * panel said 320, its positioning wrapper said 280, and the Status Drawer's
 * offset hand-typed 296 (`8 + 280 + 8`) computed from the WRAPPER. So the panel
 * overflowed its wrapper by 40px and the drawer -- one z-index above it --
 * overlapped the panel by 32px. `statusDrawerOffset` derives the offset from the
 * width, which makes that disagreement unrepresentable rather than merely
 * corrected.
 */
import { describe, it, expect } from 'vitest'
import {
  PANEL_CHROME, PANEL_BODY_DEFAULT, PANEL_BODY_EXPANDED,
  PANEL_BOTTOM_OFFSET, PANEL_TOP_RESERVE, PANEL_GAP, GIT_PANEL_WIDTH,
  defaultPanelHeight, maxPanelHeight, resolvePanelHeight, statusDrawerOffset,
} from '../panelGeometry'

const TALL_WINDOW = 1400

describe('defaultPanelHeight', () => {
  it('is the body plus the chrome, in both UI densities', () => {
    expect(defaultPanelHeight(false)).toBe(PANEL_BODY_DEFAULT + PANEL_CHROME)
    expect(defaultPanelHeight(true)).toBe(PANEL_BODY_EXPANDED + PANEL_CHROME)
  })
})

describe('resolvePanelHeight — the clamp is the whole mechanism', () => {
  it('uses the default when there is no override', () => {
    expect(resolvePanelHeight(null, defaultPanelHeight(false), TALL_WINDOW))
      .toBe(defaultPanelHeight(false))
  })

  it('honours an override between the floor and the ceiling', () => {
    const d = defaultPanelHeight(false)
    expect(resolvePanelHeight(d + 120, d, TALL_WINDOW)).toBe(d + 120)
  })

  it('treats the default as a FLOOR: a shorter override clamps back up', () => {
    // The operator asked that a drag can never make a panel shorter than it is
    // today, which is a floor rather than a minimum the drag negotiates.
    const d = defaultPanelHeight(false)
    expect(resolvePanelHeight(d - 200, d, TALL_WINDOW)).toBe(d)
  })

  it('treats the viewport as a ceiling', () => {
    const d = defaultPanelHeight(false)
    const winHeight = 900
    expect(resolvePanelHeight(99_999, d, winHeight))
      .toBe(winHeight - PANEL_BOTTOM_OFFSET - PANEL_TOP_RESERVE)
  })

  it('lifts a stale override when expandedUI raises the default underneath it', () => {
    // 482 was a legitimate height in the normal density and is BELOW the floor
    // once the UI expands. Deriving on every render is what makes that automatic
    // instead of needing a migration when the density flips.
    const expanded = defaultPanelHeight(true)
    expect(resolvePanelHeight(482, expanded, TALL_WINDOW)).toBe(expanded)
    expect(expanded).toBe(PANEL_BODY_EXPANDED + PANEL_CHROME)
  })

  it('never returns less than the default in a very short window', () => {
    // The max() inside maxPanelHeight: without it the ceiling would fall below
    // the floor, the clamp would indivert, and every panel would pin to a few
    // pixels.
    const d = defaultPanelHeight(true)
    expect(resolvePanelHeight(null, d, 200)).toBe(d)
    expect(maxPanelHeight(200, d)).toBe(d)
  })
})

describe('statusDrawerOffset — the overlap fix', () => {
  it('clears the git panel by a gap on each side when it is open', () => {
    // This is the assertion that fails if either value is hand-edited out of
    // agreement again.
    expect(statusDrawerOffset(true)).toBe(GIT_PANEL_WIDTH + 2 * PANEL_GAP)
  })

  it('is just the gap when the panel is closed', () => {
    expect(statusDrawerOffset(false)).toBe(PANEL_GAP)
  })

  it('leaves no overlap: the drawer starts past the panel edge', () => {
    // The panel occupies [PANEL_GAP, PANEL_GAP + GIT_PANEL_WIDTH).
    const panelRightEdge = PANEL_GAP + GIT_PANEL_WIDTH
    expect(statusDrawerOffset(true)).toBeGreaterThanOrEqual(panelRightEdge)
  })
})
