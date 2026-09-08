/**
 * Tests for visibility.ts (child 07): rules AND together, scope is applied
 * before filters, and a hidden node retains its model entry (this module
 * never removes anything from `model`, only computes the visible-id set).
 */
import { describe, expect, it } from 'vitest'
import Graph from 'graphology'
import { computeVisibility } from './visibility'
import type { GraphFilterRule } from '../../../../shared/graph-view-types'
import type { GraphModel, GraphNode } from '../../../../shared/graph-model-types'

function node(id: string, frontMatter: Record<string, unknown> = {}): GraphNode {
  return { id, kind: 'document', label: id, frontMatter, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false }
}

function buildGraphAndModel(edges: [string, string][], nodeIds: string[]): { graph: Graph; model: GraphModel } {
  const graph = new Graph({ multi: true, type: 'mixed' })
  for (const id of nodeIds) graph.addNode(id)
  for (const [a, b] of edges) graph.addUndirectedEdge(a, b)
  const model: GraphModel = {
    nodes: nodeIds.map((id) => node(id, id === 'a' ? { status: 'active' } : { status: 'done' })),
    edges: [],
    dangling: [],
    anchorSuppressions: [],
    discoveredFields: ['status'],
    identityCollisions: [],
    centralityMethod: 'degree',
  }
  return { graph, model }
}

describe('computeVisibility', () => {
  it('scope is applied before filters: an inclusionary filter never reaches outside scope', () => {
    const { graph, model } = buildGraphAndModel([['a', 'b'], ['b', 'c']], ['a', 'b', 'c', 'd'])
    // d is 'active' too but outside the a-b-c chain's 1-hop neighborhood of 'a'.
    model.nodes.find((n) => n.id === 'd')!.frontMatter.status = 'active'

    const rules: GraphFilterRule[] = [{ dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active', 'done'] }]
    const visible = computeVisibility(model, graph, rules, { mode: 'neighborhood', anchorId: 'a', depth: 1 })
    expect(visible.has('d')).toBe(false)
    expect(visible.has('a')).toBe(true)
    expect(visible.has('b')).toBe(true)
  })

  it('rules AND together', () => {
    const { graph, model } = buildGraphAndModel([], ['a', 'b'])
    const rules: GraphFilterRule[] = [
      { dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active'] },
      { dimension: { source: 'frontMatter', field: 'status' }, mode: 'exclude', values: ['active'] },
    ]
    const visible = computeVisibility(model, graph, rules, { mode: 'corpus', anchorId: null, depth: 1 })
    expect(visible.size).toBe(0)
  })

  it('a hidden node is simply absent from the visible set, the model is unaffected', () => {
    const { graph, model } = buildGraphAndModel([], ['a', 'b'])
    const rules: GraphFilterRule[] = [{ dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active'] }]
    const visible = computeVisibility(model, graph, rules, { mode: 'corpus', anchorId: null, depth: 1 })
    expect(visible.has('b')).toBe(false)
    expect(model.nodes.some((n) => n.id === 'b')).toBe(true)
  })

  it('an expanded node widens a neighborhood scope by exactly its own 1-hop neighbourhood', () => {
    // a — b — c — d — e; anchor a at depth 1 sees {a, b}; expanding d adds {c, d, e}.
    const { graph, model } = buildGraphAndModel([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f']], ['a', 'b', 'c', 'd', 'e', 'f'])
    const base = computeVisibility(model, graph, [], { mode: 'neighborhood', anchorId: 'a', depth: 1 })
    expect([...base].sort()).toEqual(['a', 'b'])

    const expanded = computeVisibility(model, graph, [], { mode: 'neighborhood', anchorId: 'a', depth: 1, expandedIds: new Set(['d']) })
    expect([...expanded].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('expanded ids are ignored in corpus scope', () => {
    const { graph, model } = buildGraphAndModel([], ['a', 'b'])
    const visible = computeVisibility(model, graph, [], { mode: 'corpus', anchorId: null, depth: 1, expandedIds: new Set(['ghost']) })
    expect(visible.size).toBe(2)
  })

  it('corpus scope with no filters shows every node', () => {
    const { graph, model } = buildGraphAndModel([], ['a', 'b'])
    const visible = computeVisibility(model, graph, [], { mode: 'corpus', anchorId: null, depth: 1 })
    expect(visible.size).toBe(2)
  })
})

describe('showOrphans', () => {
  it('hides orphan documents on top of scope and filters, and restores them when shown', () => {
    const { graph, model } = buildGraphAndModel([['a', 'b']], ['a', 'b', 'c'])
    model.nodes.find((n) => n.id === 'c')!.orphan = true
    const scope = { mode: 'corpus' as const, anchorId: null, depth: 1 }
    expect(computeVisibility(model, graph, [], scope, { showOrphans: true }).has('c')).toBe(true)
    const hidden = computeVisibility(model, graph, [], scope, { showOrphans: false })
    expect(hidden.has('c')).toBe(false)
    expect(hidden.has('a')).toBe(true)
    expect(model.nodes.some((n) => n.id === 'c')).toBe(true)
  })
})

describe('direction, dangling stubs, and hidden nodes', () => {
  it('a neighborhood scope can follow links out, in, or both ways', () => {
    // a -> b -> c as stored direction (a links to b, b links to c).
    const { graph, model } = buildGraphAndModel([['a', 'b'], ['b', 'c']], ['a', 'b', 'c'])
    const anchor = (direction: 'out' | 'in' | 'both'): string[] => [...computeVisibility(model, graph, [], { mode: 'neighborhood', anchorId: 'b', depth: 1, direction })].sort()
    expect(anchor('both')).toEqual(['a', 'b', 'c'])
    expect(anchor('out')).toEqual(['b', 'c'])
    expect(anchor('in')).toEqual(['a', 'b'])
  })

  it('showDangling: false withholds every dangling stub', () => {
    const { graph, model } = buildGraphAndModel([['a', 'ghost']], ['a', 'ghost'])
    model.nodes.find((n) => n.id === 'ghost')!.kind = 'dangling'
    const scope = { mode: 'corpus' as const, anchorId: null, depth: 1 }
    expect(computeVisibility(model, graph, [], scope, { showDangling: true }).has('ghost')).toBe(true)
    const hidden = computeVisibility(model, graph, [], scope, { showDangling: false })
    expect(hidden.has('ghost')).toBe(false)
    expect(hidden.has('a')).toBe(true)
  })

  it('a hidden node stays hidden whatever the rules say', () => {
    const { graph, model } = buildGraphAndModel([['a', 'b']], ['a', 'b'])
    const scope = { mode: 'corpus' as const, anchorId: null, depth: 1 }
    const visible = computeVisibility(model, graph, [], scope, { hiddenNodeIds: new Set(['b']) })
    expect([...visible]).toEqual(['a'])
  })
})
