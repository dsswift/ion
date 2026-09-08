/**
 * Pins the anti-collision pass: after a force layout settles, no two nodes
 * may draw as intersecting discs at the framing Sigma uses (graph extent
 * mapped onto the smaller viewport dimension at camera ratio 1).
 *
 * These are regression tests for the reported rendering defect: FA2 lays out
 * points, so weighted/enlarged nodes piled into unreadable blobs while the
 * degree-1 nodes around the rim — which never overlapped — looked fine.
 */
import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { resolveNodeOverlaps } from './graph-overlap'

const VIEWPORT = { width: 1000, height: 1000 }

/** Pairs whose discs intersect, in graph units — sizes are close enough for a relative check. */
function countOverlaps(graph: Graph): number {
  const nodes: { x: number; y: number; r: number }[] = []
  graph.forEachNode((_id, a) => nodes.push({ x: a.x as number, y: a.y as number, r: a.size as number }))
  let count = 0
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y) < nodes[i].r + nodes[j].r) count++
    }
  }
  return count
}

function pixelDistance(graph: Graph, a: string, b: string, unitsPerPixel: number): number {
  const dx = (graph.getNodeAttribute(a, 'x') as number) - (graph.getNodeAttribute(b, 'x') as number)
  const dy = (graph.getNodeAttribute(a, 'y') as number) - (graph.getNodeAttribute(b, 'y') as number)
  return Math.sqrt(dx * dx + dy * dy) / unitsPerPixel
}

describe('resolveNodeOverlaps', () => {
  it('separates two large overlapping nodes to at least the sum of their radii', () => {
    const graph = new Graph()
    graph.addNode('a', { x: 0, y: 0, size: 20 })
    graph.addNode('b', { x: 1, y: 0, size: 20 })
    // A third node fixes a real extent; two nodes one unit apart would make
    // the span degenerate and the conversion meaningless.
    graph.addNode('c', { x: 500, y: 500, size: 5 })

    const result = resolveNodeOverlaps(graph, VIEWPORT)

    expect(result.remainingOverlaps).toBe(0)
    expect(result.movedNodes).toBeGreaterThan(0)
    // 40px is the sum of the two radii; the pass resolves to within half a pixel.
    expect(pixelDistance(graph, 'a', 'b', result.unitsPerPixel)).toBeGreaterThanOrEqual(39.5)
  })

  it('leaves an already-separated layout untouched', () => {
    const graph = new Graph()
    graph.addNode('a', { x: 0, y: 0, size: 4 })
    graph.addNode('b', { x: 400, y: 0, size: 4 })
    graph.addNode('c', { x: 0, y: 400, size: 4 })

    const result = resolveNodeOverlaps(graph, VIEWPORT)

    expect(result.movedNodes).toBe(0)
    expect(graph.getNodeAttribute('a', 'x')).toBe(0)
    expect(graph.getNodeAttribute('b', 'x')).toBe(400)
  })

  it('pulls a dense colocated cluster apart without producing non-finite positions', () => {
    const graph = new Graph()
    for (let i = 0; i < 30; i++) graph.addNode(`n${i}`, { x: 0, y: 0, size: 10 })
    graph.addNode('far', { x: 800, y: 800, size: 10 })

    const before = countOverlaps(graph)
    resolveNodeOverlaps(graph, VIEWPORT)

    graph.forEachNode((_id, attrs) => {
      expect(Number.isFinite(attrs.x)).toBe(true)
      expect(Number.isFinite(attrs.y)).toBe(true)
    })
    expect(countOverlaps(graph)).toBeLessThan(before)
  })

  it('will not move a node further than its displacement budget', () => {
    // The pass is a correction, not a second layout. In a region the
    // simulation left dense, resolving every overlap means close-packing it
    // — which inflates that region into an evenly spaced disc and erases
    // the structure underneath. Bounded, it separates what it can.
    const graph = new Graph()
    for (let i = 0; i < 60; i++) graph.addNode(`n${i}`, { x: (i % 8) * 2, y: Math.floor(i / 8) * 2, size: 12 })
    graph.addNode('far', { x: 900, y: 900, size: 4 })
    const before = new Map<string, { x: number; y: number }>()
    graph.forEachNode((id, a) => before.set(id, { x: a.x as number, y: a.y as number }))

    const result = resolveNodeOverlaps(graph, VIEWPORT)

    // 12px radius + 1px half-padding, converted to graph units, times the
    // four-radius budget — with generous slack for the pre-dispersal step.
    const budget = 13 * result.unitsPerPixel * 4 * 2
    graph.forEachNode((id, attrs) => {
      const from = before.get(id)!
      expect(Math.hypot((attrs.x as number) - from.x, (attrs.y as number) - from.y)).toBeLessThanOrEqual(budget)
    })
  })

  it('is deterministic — the same input yields the same positions', () => {
    const build = (): Graph => {
      const g = new Graph()
      for (let i = 0; i < 12; i++) g.addNode(`n${i}`, { x: (i % 3) * 2, y: Math.floor(i / 3) * 2, size: 12 })
      g.addNode('far', { x: 600, y: 600, size: 6 })
      return g
    }
    const first = build()
    const second = build()
    resolveNodeOverlaps(first, VIEWPORT)
    resolveNodeOverlaps(second, VIEWPORT)

    first.forEachNode((id, attrs) => {
      expect(attrs.x).toBe(second.getNodeAttribute(id, 'x'))
      expect(attrs.y).toBe(second.getNodeAttribute(id, 'y'))
    })
  })

  it('falls back to the kind/degree size when a node carries no size attribute', () => {
    const graph = new Graph()
    graph.addNode('a', { x: 0, y: 0, kind: 'document', degree: 100 })
    graph.addNode('b', { x: 1, y: 0, kind: 'document', degree: 100 })
    graph.addNode('c', { x: 400, y: 400, kind: 'document', degree: 0 })

    const result = resolveNodeOverlaps(graph, VIEWPORT)

    expect(result.movedNodes).toBeGreaterThan(0)
    expect(result.remainingOverlaps).toBe(0)
  })

  it('displaces only the movable nodes, and resolves the pair anyway', () => {
    // A drag needs the crowd to yield around the grabbed node without the
    // rest of the operator's arrangement drifting. A pinned node still
    // collides; it just does not move, so the free end absorbs the whole
    // separation.
    const graph = new Graph()
    graph.addNode('pinned', { x: 0, y: 0, size: 20 })
    graph.addNode('free', { x: 5, y: 0, size: 20 })
    graph.addNode('anchor', { x: 500, y: 500, size: 5 })

    const result = resolveNodeOverlaps(graph, VIEWPORT, { movable: new Set(['free']) })

    expect(graph.getNodeAttribute('pinned', 'x')).toBe(0)
    expect(graph.getNodeAttribute('pinned', 'y')).toBe(0)
    expect(pixelDistance(graph, 'pinned', 'free', result.unitsPerPixel)).toBeGreaterThanOrEqual(39.5)
  })

  it('no-ops on a degenerate viewport rather than dividing by zero', () => {
    const graph = new Graph()
    graph.addNode('a', { x: 0, y: 0, size: 10 })
    graph.addNode('b', { x: 0, y: 0, size: 10 })

    const result = resolveNodeOverlaps(graph, { width: 0, height: 0 })

    expect(result.movedNodes).toBe(0)
    expect(graph.getNodeAttribute('a', 'x')).toBe(0)
  })
})
