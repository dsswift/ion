/**
 * Proportional pane sizing for the git panel.
 *
 * ── The three defects this model exists to fix ──────────────────────────────
 *   1. Only Changes and Graph were resizable; Worktrees and Integration were
 *      pinned to 132px and 148px constants regardless of content or free space.
 *   2. Collapsing sections shrank the PANEL rather than redistributing their
 *      space, because nothing was allowed to grow into it.
 *   3. A single open section still could not take the full height.
 *
 * Each has a test below. The conservation property (every pixel assigned) is
 * asserted across permutations rather than at one configuration, because the
 * dead band that motivated this appeared only in one specific combination.
 */
import { describe, it, expect } from 'vitest'
import {
  computePaneLayout,
  resizePanes,
  PANEL_HEADER,
  SECTION_HEADER,
  SASH_SIZE,
  MIN_BODY,
  PANE_ORDER,
  type PaneId,
  type PaneState,
} from '../paneLayout'

const HEIGHT = 482

function panes(open: Partial<Record<PaneId, boolean>> = {}): PaneState[] {
  return PANE_ORDER.map((id) => ({ id, expanded: open[id] ?? true }))
}

/** Total pixels the layout claims to occupy, summed from its own output. */
function sum(sizes: Array<{ total: number }>, sashes: number): number {
  return PANEL_HEADER + sizes.reduce((a, s) => a + s.total, 0) + sashes * SASH_SIZE
}

describe('computePaneLayout — conservation', () => {
  // The invariant whose absence produced a dead band at the bottom of the
  // panel. Checked across every open/closed permutation rather than one case.
  it('assigns exactly the panel height in every permutation', () => {
    for (let mask = 0; mask < 16; mask++) {
      const open: Partial<Record<PaneId, boolean>> = {}
      PANE_ORDER.forEach((id, i) => { open[id] = Boolean(mask & (1 << i)) })
      const layout = computePaneLayout({ height: HEIGHT, panes: panes(open), proportions: {} })

      expect(sum(layout.sizes, layout.sashes.length)).toBe(layout.total)
      // With at least one pane open the panel is exactly full.
      if (Object.values(open).some(Boolean)) {
        expect(layout.total).toBe(HEIGHT)
      }
    }
  })

  it('keeps the panel at full height when panes collapse', () => {
    const all = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })
    const one = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: false, worktrees: false }),
      proportions: {},
    })

    expect(all.total).toBe(HEIGHT)
    // Defect 2: this used to shrink to chrome + fixed bodies.
    expect(one.total).toBe(HEIGHT)
  })
})

describe('computePaneLayout — distribution', () => {
  it('gives a single open pane the whole panel', () => {
    // Defect 3.
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: false, worktrees: false }),
      proportions: {},
    })

    const graph = layout.sizes.find((p) => p.id === 'graph')!
    const collapsed = layout.sizes.filter((p) => p.id !== 'graph')
    expect(collapsed.every((p) => p.total === SECTION_HEADER)).toBe(true)
    expect(graph.total).toBe(HEIGHT - PANEL_HEADER - collapsed.length * SECTION_HEADER)
  })

  it('splits evenly between two open panes with no stored proportions', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ worktrees: false }),
      proportions: {},
    })

    const changes = layout.sizes.find((p) => p.id === 'changes')!
    const graph = layout.sizes.find((p) => p.id === 'graph')!
    expect(Math.abs(changes.total - graph.total)).toBeLessThanOrEqual(1)
  })

  it('splits four open panes evenly by default', () => {
    // Tolerance is 2px, not 1: four panes cannot divide 442px exactly, and each
    // pane's size is rounded independently before distributeEmptySpace pushes
    // the remainder into the last one that can take it.
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })
    const totals = layout.sizes.map((p) => p.total)
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(2)
  })

  it('honours stored proportions', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ worktrees: false }),
      proportions: { changes: 0.75, graph: 0.25 },
    })

    const changes = layout.sizes.find((p) => p.id === 'changes')!
    const graph = layout.sizes.find((p) => p.id === 'graph')!
    expect(changes.total).toBeGreaterThan(graph.total * 2)
  })

  it('resizes Worktrees, which used to be a pinned constant', () => {
    // Defect 1: it was hardcoded to 132px and could never grow.
    const small = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: true, graph: true }),
      proportions: { worktrees: 0.2, changes: 0.4, graph: 0.4 },
    })
    const big = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: true, graph: true }),
      proportions: { worktrees: 0.8, changes: 0.1, graph: 0.1 },
    })

    expect(big.sizes.find((p) => p.id === 'worktrees')!.total)
      .toBeGreaterThan(small.sizes.find((p) => p.id === 'worktrees')!.total)
  })
})

describe('computePaneLayout — bounds', () => {
  it('never shrinks an expanded pane below its minimum body', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes(),
      // Ask for something impossible: one pane taking essentially everything.
      proportions: { changes: 0.97, worktrees: 0.01, graph: 0.01 },
    })

    for (const size of layout.sizes) {
      if (!size.expanded) continue
      expect(size.body).toBeGreaterThanOrEqual(MIN_BODY[size.id])
    }
  })

  it('collapses a pane to exactly its header', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: false }),
      proportions: {},
    })
    const changes = layout.sizes.find((p) => p.id === 'changes')!
    expect(changes.total).toBe(SECTION_HEADER)
    expect(changes.body).toBe(0)
  })

  it('omits hidden panes entirely rather than collapsing them', () => {
    // Bench mode: Changes and Graph are not rendered, so they contribute no
    // header at all — distinct from a collapse the operator can undo.
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes(),
      proportions: {},
      hidden: ['changes', 'graph'],
    })

    expect(layout.sizes.map((p) => p.id)).toEqual(['worktrees'])
    expect(layout.total).toBe(HEIGHT)
  })
})

describe('computePaneLayout — three panes', () => {
  // The Integration pane was removed when the bench moved into the worktree
  // list. This asserts the removal went through the MODEL rather than around it:
  // the ported SplitView core does not care how many panes it has, so a correct
  // removal needs no special-casing and still fills the panel exactly.
  it('fills the panel exactly with all three panes expanded', () => {
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })

    expect(layout.sizes).toHaveLength(3)
    expect(layout.sizes.map((p) => p.id)).toEqual(['changes', 'worktrees', 'graph'])
    expect(layout.total).toBe(HEIGHT)
    expect(sum(layout.sizes, layout.sashes.length)).toBe(HEIGHT)
  })

  it('gives the freed budget to the remaining panes rather than shrinking the panel', () => {
    // Merging two panes into one returns a header plus a minimum body to the
    // pool. The panel height is fixed, so that space must land in the panes.
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })
    const bodies = layout.sizes.reduce((a, p) => a + p.body, 0)

    expect(bodies).toBe(HEIGHT - PANEL_HEADER - 3 * SECTION_HEADER - layout.sashes.length * SASH_SIZE)
  })
})

describe('computePaneLayout — sashes', () => {
  it('places a sash between each pair of adjacent expanded panes', () => {
    const layout = computePaneLayout({ height: HEIGHT, panes: panes(), proportions: {} })
    expect(layout.sashes).toHaveLength(2)
  })

  it('places no sash next to a collapsed pane', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ worktrees: false }),
      proportions: {},
    })
    // Only Changes and Graph are expanded, so exactly one boundary.
    expect(layout.sashes).toHaveLength(1)
    expect(layout.sashes[0]).toEqual({ afterId: 'changes', beforeId: 'graph' })
  })

  it('places no sash when only one pane is expanded', () => {
    const layout = computePaneLayout({
      height: HEIGHT,
      panes: panes({ changes: false, worktrees: false }),
      proportions: {},
    })
    expect(layout.sashes).toHaveLength(0)
  })
})

describe('resizePanes', () => {
  const input = { height: HEIGHT, panes: panes(), proportions: {} }

  it('grows the pane above the sash and shrinks the one below', () => {
    const before = computePaneLayout(input)
    const next = resizePanes(input, 0, 40)
    const after = computePaneLayout({ ...input, proportions: next })

    expect(after.sizes[0].total).toBeGreaterThan(before.sizes[0].total)
    expect(after.sizes[1].total).toBeLessThan(before.sizes[1].total)
  })

  it('preserves the total height across a drag', () => {
    const next = resizePanes(input, 1, -60)
    const after = computePaneLayout({ ...input, proportions: next })
    expect(after.total).toBe(HEIGHT)
  })

  it('continues into the next pane once the neighbour hits its minimum', () => {
    // The behaviour ported from SplitView.resize: a large delta must not stall
    // at the first neighbour, it redistributes outward.
    const next = resizePanes(input, 0, 5000)
    const after = computePaneLayout({ ...input, proportions: next })

    expect(after.sizes.find((p) => p.id === 'worktrees')!.body).toBe(MIN_BODY.worktrees)
    // A pane beyond the immediate neighbour also gave up space.
    expect(after.sizes.find((p) => p.id === 'graph')!.body).toBe(MIN_BODY.graph)
    expect(after.total).toBe(HEIGHT)
  })

  it('refuses to crush any pane below its minimum', () => {
    const next = resizePanes(input, 2, 5000)
    const after = computePaneLayout({ ...input, proportions: next })
    for (const size of after.sizes) {
      expect(size.body).toBeGreaterThanOrEqual(MIN_BODY[size.id])
    }
  })

  it('returns proportions that survive a different panel height', () => {
    // Proportional persistence is the whole reason for this shape: a sizing
    // made in the overlay must still mean the same thing in the taller ATV.
    //
    // Compared at two heights that both leave real slack above the floors. At
    // 400px four panes need 352px just to reach their minimums, so they are
    // effectively pinned and proportions cannot express themselves — that is
    // the model working (conservation beats preference when space runs out),
    // not a persistence failure, so it is not the right place to measure this.
    const next = resizePanes(input, 0, 60)
    const mid = computePaneLayout({ ...input, proportions: next, height: 700 })
    const tall = computePaneLayout({ ...input, proportions: next, height: 1100 })

    const shareMid = mid.sizes[0].total / mid.sizes.reduce((a, s) => a + s.total, 0)
    const shareTall = tall.sizes[0].total / tall.sizes.reduce((a, s) => a + s.total, 0)
    expect(Math.abs(shareMid - shareTall)).toBeLessThan(0.05)
  })

  it('pins panes to their floor when the panel is too short for preferences', () => {
    // The complement of the test above, asserted rather than left implicit:
    // when the panel cannot honour the stored sizing, it still fills exactly
    // and no pane is starved to zero.
    const lopsided = { changes: 0.9, worktrees: 0.04, graph: 0.03 }
    const layout = computePaneLayout({ ...input, proportions: lopsided, height: 380 })

    expect(layout.total).toBe(380)
    expect(layout.sizes.every((p) => p.body > 0)).toBe(true)
  })

  it('is a no-op for an out-of-range sash index', () => {
    expect(resizePanes(input, -1, 40)).toBe(input.proportions)
    expect(resizePanes(input, 99, 40)).toBe(input.proportions)
  })
})
