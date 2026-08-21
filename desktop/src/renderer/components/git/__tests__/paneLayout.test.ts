import { describe, expect, it } from 'vitest'
import { computePaneLayout, resizePanes, PANEL_HEADER, SECTION_HEADER, SASH_SIZE, MIN_BODY, PANE_ORDER, type PaneId, type PaneState } from '../paneLayout'

const HEIGHT = 482
function panes(open: Partial<Record<PaneId, boolean>> = {}): PaneState[] { return PANE_ORDER.map((id) => ({ id, expanded: open[id] ?? true })) }
function sum(sizes: Array<{ total: number }>, sashes: number): number { return PANEL_HEADER + sizes.reduce((total, size) => total + size.total, 0) + sashes * SASH_SIZE }

describe('computePaneLayout', () => {
  it('fills the panel with Changes and Graph only', () => {
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })
    expect(layout.sizes.map((size) => size.id)).toEqual(['changes', 'graph'])
    expect(layout.total).toBe(HEIGHT)
    expect(sum(layout.sizes, layout.sashes.length)).toBe(HEIGHT)
  })

  it('gives one open pane the freed budget', () => {
    const layout = computePaneLayout({ height: HEIGHT, panes: panes({ changes: false }), proportions: {} })
    expect(layout.sizes.find((size) => size.id === 'changes')!.total).toBe(SECTION_HEADER)
    expect(layout.sizes.find((size) => size.id === 'graph')!.total).toBe(HEIGHT - PANEL_HEADER - SECTION_HEADER)
  })

  it('honors stored Changes and Graph proportions', () => {
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: { changes: 0.75, graph: 0.25 } })
    expect(layout.sizes.find((size) => size.id === 'changes')!.total).toBeGreaterThan(layout.sizes.find((size) => size.id === 'graph')!.total * 2)
  })

  it('keeps both panes above their floor after a drag', () => {
    const input = { height: HEIGHT, panes: panes(), proportions: {} }
    const next = resizePanes(input, 0, 5000)
    const layout = computePaneLayout({ ...input, proportions: next })
    expect(layout.sizes.find((size) => size.id === 'graph')!.body).toBe(MIN_BODY.graph)
    expect(layout.total).toBe(HEIGHT)
  })
})
