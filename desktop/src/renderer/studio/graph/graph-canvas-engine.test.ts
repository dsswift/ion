/**
 * `settleOverlap` decides how far a settle's re-spacing may reach. Two
 * defects lived here: the pass was gated to the FIRST layout, so every drop
 * settled with the padding gone, and nothing bounded its reach, so running
 * it on every settle would have re-spaced arrangements built by hand.
 */
import Graph from 'graphology'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn() }))

import { settleOverlap } from './graph-canvas-engine'

const VIEWPORT = { width: 800, height: 600 }

/** `a` and `b` drawn on top of one another; `far` is nowhere near either. */
function overlapping(): Graph {
  const g = new Graph()
  g.addNode('a', { x: 0, y: 0, kind: 'document', degree: 1, size: 20 })
  g.addNode('b', { x: 2, y: 0, kind: 'document', degree: 1, size: 20 })
  g.addNode('far', { x: 9000, y: 9000, kind: 'document', degree: 1, size: 20 })
  return g
}

function at(g: Graph, id: string): { x: number; y: number } {
  return { x: g.getNodeAttribute(id, 'x') as number, y: g.getNodeAttribute(id, 'y') as number }
}

function gap(g: Graph): number {
  const a = at(g, 'a')
  const b = at(g, 'b')
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('settleOverlap', () => {
  it('separates an overlapping pair after a drop, not only after the first layout', () => {
    const g = overlapping()
    const before = gap(g)
    const result = settleOverlap(g, VIEWPORT, { runReason: 'drop', freeIds: null, pinned: new Set() })
    expect(gap(g)).toBeGreaterThan(before)
    expect(result.movedNodes).toBeGreaterThan(0)
  })

  it('a confined settle moves only its free nodes and leaves the rest exactly where they were', () => {
    const g = overlapping()
    const aBefore = at(g, 'a')
    settleOverlap(g, VIEWPORT, { runReason: 'drop', freeIds: new Set(['b']), pinned: new Set() })
    // `a` stands in for the node just dropped: it is never in the free set,
    // so it keeps the position the hand left it while `b` moves clear.
    expect(at(g, 'a')).toEqual(aBefore)
    expect(at(g, 'b')).not.toEqual({ x: 2, y: 0 })
  })

  it('a pinned node holds its ground even when the settle is unconfined', () => {
    const g = overlapping()
    const aBefore = at(g, 'a')
    settleOverlap(g, VIEWPORT, { runReason: 'initial', freeIds: null, pinned: new Set(['a']) })
    expect(at(g, 'a')).toEqual(aBefore)
    expect(at(g, 'b')).not.toEqual({ x: 2, y: 0 })
  })

  it('never moves a node outside the free set, however many there are', () => {
    const g = overlapping()
    const farBefore = at(g, 'far')
    settleOverlap(g, VIEWPORT, { runReason: 'structure', freeIds: new Set(['a']), pinned: new Set() })
    expect(at(g, 'far')).toEqual(farBefore)
  })
})
