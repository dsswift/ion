// @vitest-environment jsdom
/**
 * The drag confinement: what may move while the hand is on a node, and
 * what settles when it lets go. Both are known by construction from the
 * graph, never inferred from displacement — an unconfined run moves every
 * node past any epsilon, which is how a "local" settle once freed the
 * whole corpus on every drop.
 */
import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { dragSetFor, settleSetForDrop, DRAG_CONFINE_DEPTH } from './graph-canvas-drag'

/** d — n1 — n2 — n3 — far, with `pinned` hanging off n1 and `island` alone. */
function chain(): Graph {
  const g = new Graph()
  for (const id of ['d', 'n1', 'n2', 'n3', 'far', 'pinned', 'island']) g.addNode(id, { x: 0, y: 0 })
  g.addEdge('d', 'n1')
  g.addEdge('n1', 'n2')
  g.addEdge('n2', 'n3')
  g.addEdge('n3', 'far')
  g.addEdge('n1', 'pinned')
  return g
}

describe('dragSetFor', () => {
  it('frees the grabbed node\'s neighbourhood to the confinement depth, never the node itself, the pinned, or the far', () => {
    expect(DRAG_CONFINE_DEPTH).toBe(2)
    const free = dragSetFor(chain(), 'd', new Set(['pinned']))
    expect([...free].sort()).toEqual(['n1', 'n2'])
  })

  it('an isolated node frees nothing', () => {
    expect(dragSetFor(chain(), 'island', new Set()).size).toBe(0)
  })
})

describe('settleSetForDrop', () => {
  it('frees what the drag let move plus the dropped node\'s neighbours, holds the dropped node and the pinned', () => {
    const g = chain()
    // The drag carried d next to `far`, so a new edge would not exist but
    // its current neighbours (n1, pinned) are what it now rests against.
    const free = settleSetForDrop(g, 'd', new Set(['n1', 'n2']), new Set(['pinned']))
    expect([...free].sort()).toEqual(['n1', 'n2'])
    expect(free.has('d')).toBe(false)
    expect(free.has('pinned')).toBe(false)
    expect(free.has('far')).toBe(false)
  })

  it('never frees the whole graph: the settle is the drag set, not a displacement test', () => {
    const g = chain()
    g.forEachNode((id) => g.setNodeAttribute(id, 'x', Math.random() * 100))
    const free = settleSetForDrop(g, 'd', dragSetFor(g, 'd', new Set()), new Set())
    expect(free.size).toBeLessThan(g.order - 1)
  })
})
