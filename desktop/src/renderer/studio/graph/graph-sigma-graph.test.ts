/**
 * Tests for graph-sigma-graph.ts (child 05): incremental sync without
 * rebuild, position preservation, and new-node centroid placement.
 */
import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { placeNewNode, syncSigmaGraph, buildCoarsenedGraph } from './graph-sigma-graph'
import type { GraphModel } from '../../../shared/graph-model-types'

function baseModel(overrides?: Partial<GraphModel>): GraphModel {
  return {
    nodes: [],
    edges: [],
    dangling: [],
    anchorSuppressions: [],
    discoveredFields: [],
    identityCollisions: [],
    centralityMethod: 'degree',
    ...overrides,
  }
}

describe('syncSigmaGraph', () => {
  it('adds nodes and edges from an empty graph', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const model = baseModel({
      nodes: [
        { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false },
        { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false },
      ],
      edges: [{ id: 'a|b|wikilink|', source: 'a', target: 'b', directed: false, origin: 'wikilink', multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 }],
    })
    syncSigmaGraph(graph, model, new Map())
    expect(graph.order).toBe(2)
    expect(graph.size).toBe(1)
  })

  it('a second sync with one changed node preserves every other node x/y', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const model1 = baseModel({
      nodes: [
        { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
        { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
      ],
    })
    syncSigmaGraph(graph, model1, new Map())
    graph.setNodeAttribute('a', 'x', 42)
    graph.setNodeAttribute('a', 'y', 99)
    graph.setNodeAttribute('b', 'x', 7)
    graph.setNodeAttribute('b', 'y', 3)

    const model2 = baseModel({
      nodes: [
        { id: 'a', kind: 'document', label: 'A Renamed', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
        { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
      ],
    })
    syncSigmaGraph(graph, model2, new Map())

    expect(graph.getNodeAttribute('a', 'x')).toBe(42)
    expect(graph.getNodeAttribute('a', 'y')).toBe(99)
    expect(graph.getNodeAttribute('a', 'label')).toBe('A Renamed')
    expect(graph.getNodeAttribute('b', 'x')).toBe(7)
    expect(graph.getNodeAttribute('b', 'y')).toBe(3)
  })

  it('drops a node no longer in the model', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    syncSigmaGraph(graph, baseModel({ nodes: [{ id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }] }), new Map())
    expect(graph.hasNode('a')).toBe(true)
    syncSigmaGraph(graph, baseModel({ nodes: [] }), new Map())
    expect(graph.hasNode('a')).toBe(false)
  })

  it('applies a stored position to a new node before falling back to centroid', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const positions = new Map([['a', { x: 10, y: 20 }]])
    syncSigmaGraph(graph, baseModel({ nodes: [{ id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }] }), positions)
    expect(graph.getNodeAttribute('a', 'x')).toBe(10)
    expect(graph.getNodeAttribute('a', 'y')).toBe(20)
  })

  it('rejects a non-finite stored position and falls back to a jittered placement', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const positions = new Map([['a', { x: NaN, y: 20 }]])
    const reported: Array<[string, string]> = []
    syncSigmaGraph(
      graph,
      baseModel({ nodes: [{ id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }] }),
      positions,
      (nodeId, origin) => reported.push([nodeId, origin]),
    )
    expect(Number.isFinite(graph.getNodeAttribute('a', 'x'))).toBe(true)
    expect(Number.isFinite(graph.getNodeAttribute('a', 'y'))).toBe(true)
    expect(reported).toEqual([['a', 'stored']])
  })

  it('restores a stored position onto a bare rebuilt node, and does not report it as corrupt', () => {
    // `buildGraphModel` adds every node without x/y, so on a rebuild every
    // node reaches the merge branch with no coordinate. Treating that as
    // corruption re-seeded the entire settled layout on every corpus delta
    // and logged one ERROR per node while doing it.
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('a')
    const reported: Array<[string, string]> = []
    syncSigmaGraph(
      graph,
      baseModel({ nodes: [{ id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }] }),
      new Map([['a', { x: 42, y: -17 }]]),
      (nodeId, origin) => reported.push([nodeId, origin]),
    )
    expect(graph.getNodeAttribute('a', 'x')).toBe(42)
    expect(graph.getNodeAttribute('a', 'y')).toBe(-17)
    expect(reported).toEqual([])
  })

  it('repairs a node whose position went non-finite before this sync, reporting the origin', () => {
    // Simulates a node that was corrupted by a prior bug (or a future
    // regression) before this sync ran: it already exists in the graphology
    // instance with a non-finite x/y. A plain merge would preserve that
    // forever, since merge never touches x/y (see the module docstring) —
    // this is the exact bug that let one bad node crash every future Sigma
    // mount even after `placeNewNode` itself was fixed to never emit NaN.
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('a', { x: NaN, y: NaN })
    const reported: Array<[string, string]> = []
    syncSigmaGraph(
      graph,
      baseModel({ nodes: [{ id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }] }),
      new Map(),
      (nodeId, origin) => reported.push([nodeId, origin]),
    )
    expect(Number.isFinite(graph.getNodeAttribute('a', 'x'))).toBe(true)
    expect(Number.isFinite(graph.getNodeAttribute('a', 'y'))).toBe(true)
    expect(reported).toEqual([['a', 'merge-preserved']])
  })
})

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

describe('placeNewNode', () => {
  it('places near the centroid of resolved neighbours', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('a', { x: 0, y: 0 })
    graph.addNode('b', { x: 10, y: 10 })
    graph.addNode('c')
    graph.addUndirectedEdge('a', 'c')
    graph.addUndirectedEdge('b', 'c')
    const pos = placeNewNode(graph, 'c')
    expect(distance(pos, { x: 5, y: 5 })).toBeLessThanOrEqual(10)
  })

  it('places near the origin with no resolved neighbours', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    graph.addNode('a')
    const pos = placeNewNode(graph, 'a')
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(Number.isFinite(pos.y)).toBe(true)
    expect(distance(pos, { x: 0, y: 0 })).toBeLessThanOrEqual(100)
  })

  it('places near the origin for a node not in the graph', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const pos = placeNewNode(graph, 'ghost')
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(Number.isFinite(pos.y)).toBe(true)
    expect(distance(pos, { x: 0, y: 0 })).toBeLessThanOrEqual(100)
  })

  it('never collides two unrelated nodes onto the exact same point', () => {
    // Regression: a fixed {x:0, y:0} fallback stacked an entire corpus's
    // worth of unpositioned nodes on the same spot on first load, which made
    // ForceAtlas2's repulsion force divide by zero and emit NaN positions —
    // crashing Sigma's mount with "Coordinates of node ... are invalid".
    const graph = new Graph({ multi: true, type: 'mixed' })
    const positions = new Set<string>()
    for (let i = 0; i < 50; i++) {
      graph.addNode(`n${i}`)
      const pos = placeNewNode(graph, `n${i}`)
      positions.add(`${pos.x},${pos.y}`)
    }
    expect(positions.size).toBeGreaterThan(1)
  })
})

describe('buildCoarsenedGraph', () => {
  // Regression: coarsening used to collapse communities by dropping their
  // members from the graph Sigma renders. Sigma re-indexes its whole graph
  // synchronously on every drop, so collapsing a few communities meant
  // thousands of full re-indexations — the zoom-out freeze. A derived graph
  // is one swap, and it leaves the source untouched.
  function corpus(): Graph {
    const g = new Graph({ multi: true, type: 'mixed' })
    for (let i = 0; i < 6; i++) g.addNode(`a${i}`, { x: i, y: 0, kind: 'document', community: 0, size: 4 })
    for (let i = 0; i < 6; i++) g.addNode(`b${i}`, { x: i, y: 50, kind: 'document', community: 1, size: 4 })
    g.addNode('loose', { x: 200, y: 200, kind: 'document', community: 2, size: 4 })
    g.addDirectedEdgeWithKey('a0-a1', 'a0', 'a1', { directed: true })
    g.addDirectedEdgeWithKey('a0-b0', 'a0', 'b0', { directed: true })
    g.addDirectedEdgeWithKey('a1-b1', 'a1', 'b1', { directed: true })
    g.addDirectedEdgeWithKey('loose-a0', 'loose', 'a0', { directed: true })
    return g
  }

  const plan = {
    collapsed: new Map([
      [0, { community: 0, memberIds: ['a0', 'a1', 'a2', 'a3', 'a4', 'a5'], centroid: { x: 2, y: 0 } }],
      [1, { community: 1, memberIds: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5'], centroid: { x: 2, y: 50 } }],
    ]),
  }

  it('leaves the source graph untouched', () => {
    const source = corpus()
    buildCoarsenedGraph(source, plan)
    expect(source.order).toBe(13)
    expect(source.size).toBe(4)
    expect(source.hasNode('a0')).toBe(true)
  })

  it('replaces each collapsed community with one node carrying its member count', () => {
    const rendered = buildCoarsenedGraph(corpus(), plan)
    expect(rendered.hasNode('cluster:0')).toBe(true)
    expect(rendered.getNodeAttribute('cluster:0', 'memberCount')).toBe(6)
    expect(rendered.getNodeAttribute('cluster:0', 'kind')).toBe('cluster')
    expect(rendered.hasNode('a0')).toBe(false)
    expect(rendered.hasNode('loose')).toBe(true)
    expect(rendered.order).toBe(3)
  })

  it('rewrites edges onto the cluster endpoints, dropping internal and duplicate ones', () => {
    const rendered = buildCoarsenedGraph(corpus(), plan)
    // a0-a1 is internal to one community; a0-b0 and a1-b1 both become
    // cluster:0 → cluster:1 and collapse into one.
    expect(rendered.hasEdge('cluster:0', 'cluster:1')).toBe(true)
    expect(rendered.hasEdge('loose', 'cluster:0')).toBe(true)
    expect(rendered.size).toBe(2)
  })

  it('gives a cluster a bigger radius than an ordinary node', () => {
    const rendered = buildCoarsenedGraph(corpus(), plan)
    expect(rendered.getNodeAttribute('cluster:0', 'size')).toBeGreaterThan(rendered.getNodeAttribute('loose', 'size'))
  })
})

describe('pinned nodes carry the fixed attribute', () => {
  it('sets fixed on pinned nodes, clears it on the rest, and re-derives it on a later sync', () => {
    const graph = new Graph({ multi: true, type: 'mixed' })
    const m = baseModel({
      nodes: [
        { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
        { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
      ],
    })
    syncSigmaGraph(graph, m, new Map(), undefined, new Set(['a']))
    expect(graph.getNodeAttribute('a', 'fixed')).toBe(true)
    expect(graph.getNodeAttribute('b', 'fixed')).toBe(false)

    syncSigmaGraph(graph, m, new Map(), undefined, new Set(['b']))
    expect(graph.getNodeAttribute('a', 'fixed')).toBe(false)
    expect(graph.getNodeAttribute('b', 'fixed')).toBe(true)
  })
})
