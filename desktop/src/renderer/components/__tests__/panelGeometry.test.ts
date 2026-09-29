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
  PANEL_CHROME, PANEL_BODY_DEFAULT,
  PANEL_BOTTOM_OFFSET, PANEL_TOP_RESERVE, GIT_PANEL_WIDTH, STATUS_DRAWER_WIDTH,
  defaultPanelHeight, maxPanelHeight, resolvePanelHeight,
} from '../panelGeometry'

const TALL_WINDOW = 1400

describe('defaultPanelHeight', () => {
  it('is the body plus the chrome', () => {
    expect(defaultPanelHeight()).toBe(PANEL_BODY_DEFAULT + PANEL_CHROME)
  })
})

describe('resolvePanelHeight — the clamp is the whole mechanism', () => {
  it('uses the default when there is no override', () => {
    expect(resolvePanelHeight(null, defaultPanelHeight(), TALL_WINDOW))
      .toBe(defaultPanelHeight())
  })

  it('honours an override between the floor and the ceiling', () => {
    const d = defaultPanelHeight()
    expect(resolvePanelHeight(d + 120, d, TALL_WINDOW)).toBe(d + 120)
  })

  it('treats the default as a FLOOR: a shorter override clamps back up', () => {
    // The operator asked that a drag can never make a panel shorter than it is
    // today, which is a floor rather than a minimum the drag negotiates.
    const d = defaultPanelHeight()
    expect(resolvePanelHeight(d - 200, d, TALL_WINDOW)).toBe(d)
  })

  it('treats the viewport as a ceiling', () => {
    const d = defaultPanelHeight()
    const winHeight = 900
    expect(resolvePanelHeight(99_999, d, winHeight))
      .toBe(winHeight - PANEL_BOTTOM_OFFSET - PANEL_TOP_RESERVE)
  })

  it('lifts a stale override when the default is raised underneath it', () => {
    // A persisted override that is BELOW a later, taller default clamps back
    // up to that default. Deriving on every render is what makes that
    // automatic instead of needing a migration when the constant changes.
    const raised = defaultPanelHeight() + 120
    expect(resolvePanelHeight(defaultPanelHeight(), raised, TALL_WINDOW)).toBe(raised)
  })

  it('never returns less than the default in a very short window', () => {
    // The max() inside maxPanelHeight: without it the ceiling would fall below
    // the floor, the clamp would indivert, and every panel would pin to a few
    // pixels.
    const d = defaultPanelHeight()
    expect(resolvePanelHeight(null, d, 200)).toBe(d)
    expect(maxPanelHeight(200, d)).toBe(d)
  })
})

// FILE_EXPLORER_WIDTH and INBOX_PANEL_WIDTH were retired (good-citizen
// cleanup while fixing this test's stale App.tsx reads): once Studio became
// the only window, FileExplorer took over its own sizing (`width: '100%'`,
// pinned below) and StudioLeftSidebar sizes Inbox directly off
// GIT_PANEL_WIDTH, so neither constant had a real reader left.
describe('panel widths — one declaration each', () => {
  const explorerSrc = readFileSync(join(__dirname, '../FileExplorer.tsx'), 'utf-8')
  const sidebarSrc = readFileSync(join(__dirname, '../../studio/StudioLeftSidebar.tsx'), 'utf-8')

  it('Status Drawer width is unchanged at 300', () => {
    expect(STATUS_DRAWER_WIDTH).toBe(300)
  })

  it('StudioLeftSidebar (Inbox + Git dock) sizes from GIT_PANEL_WIDTH, never a literal', () => {
    expect(sidebarSrc).toContain('GIT_PANEL_WIDTH')
  })

  it('FileExplorer fills its wrapper rather than restating a width', () => {
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

  it('StatusDrawer sizes itself from an embedded prop, not a computed placement', () => {
    // Studio always renders the drawer `embedded` (StatusSurface.tsx), filling
    // its own Surface tab pane; there is no more "external placement" for a
    // second window to clear (Overlay is gone), so the width/offset logic
    // this test used to check on App.tsx now lives entirely in the
    // component's own style, gated on the `embedded` prop.
    const drawerSrc = readFileSync(join(__dirname, '../StatusDrawer.tsx'), 'utf-8')
    expect(drawerSrc).not.toContain('statusDrawerOffset')
    expect(drawerSrc).not.toContain('statusPlacement')
    expect(drawerSrc).toContain("width: embedded ? '100%' : STATUS_DRAWER_WIDTH")
  })
})
