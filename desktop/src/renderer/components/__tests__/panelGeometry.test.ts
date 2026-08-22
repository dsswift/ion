/**
 * panelGeometry — the derived height clamp and the single-source widths.
 *
 * ── The width defect these pin ──────────────────────────────────────────────
 * The git panel's width was declared three times and the three disagreed: the
 * panel said 320, its positioning wrapper said 280, and the Status Drawer's
 * offset hand-typed 296 (`8 + 280 + 8`) computed from the WRAPPER. So the panel
 * overflowed its wrapper by 40px and the drawer -- one z-index above it --
 * overlapped the panel by 32px.
 *
 * `statusDrawerOffset` is gone: at most one right-side panel is open now, so the
 * drawer never has a git panel to clear. The width-restated-at-a-second-site
 * defect is what the source scans below guard against instead.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PANEL_CHROME, PANEL_BODY_DEFAULT, PANEL_BODY_EXPANDED,
  PANEL_BOTTOM_OFFSET, PANEL_TOP_RESERVE, GIT_PANEL_WIDTH, FILE_EXPLORER_WIDTH,
  INBOX_PANEL_WIDTH, STATUS_DRAWER_WIDTH,
  defaultPanelHeight, maxPanelHeight, resolvePanelHeight,
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

describe('panel widths — one declaration each', () => {
  const appSrc = readFileSync(join(__dirname, '../../App.tsx'), 'utf-8')
  const explorerSrc = readFileSync(join(__dirname, '../FileExplorer.tsx'), 'utf-8')

  it('Explorer matches Status Drawer width', () => {
    expect(STATUS_DRAWER_WIDTH).toBe(300)
    expect(FILE_EXPLORER_WIDTH).toBe(STATUS_DRAWER_WIDTH)
  })

  it('Inbox matches Git width', () => {
    expect(GIT_PANEL_WIDTH).toBe(440)
    expect(INBOX_PANEL_WIDTH).toBe(GIT_PANEL_WIDTH)
  })

  it('App.tsx positions both panels from the constants, never a literal', () => {
    expect(appSrc).toContain('FILE_EXPLORER_WIDTH')
    expect(appSrc).toContain('INBOX_PANEL_WIDTH')
    expect(appSrc).toContain('GIT_PANEL_WIDTH')
    // The explorer wrapper's old literal. Re-typing it is how a width restated
    // at a second site drifts from the constant.
    expect(appSrc).not.toContain('width: 240')
  })

  it('FileExplorer fills its wrapper rather than restating a width', () => {
    // This is why FILE_EXPLORER_WIDTH has exactly one reader, and why the Studio window
    // dock can mount the same component at a different width.
    expect(explorerSrc).toContain("width: '100%'")
  })

  it('the git panel keeps its own width unchanged at 440', () => {
    // Pinned so a future explorer tweak doesn't drag this one along with it.
    expect(GIT_PANEL_WIDTH).toBe(440)
  })
})

describe('statusDrawerOffset is retired, not merely unused', () => {
  it('is no longer exported', async () => {
    const mod = await import('../panelGeometry')
    expect('statusDrawerOffset' in mod).toBe(false)
  })

  it('the drawer wrapper sits at the plain gap', () => {
    const appSrc = readFileSync(join(__dirname, '../../App.tsx'), 'utf-8')
    expect(appSrc).not.toContain('statusDrawerOffset')
    expect(appSrc).toContain('marginLeft: PANEL_GAP')
  })
})
