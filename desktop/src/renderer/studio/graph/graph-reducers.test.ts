// @vitest-environment jsdom
/**
 * Tests for graph-reducers.ts (children 05 and 06): reducer output for
 * each node kind and edge direction with no channel bound (child 05's
 * cases), and with a channel bound to a dimension (child 06's cases).
 */
import { describe, expect, it } from 'vitest'
import { createEdgeReducer, createNodeReducer, DIMMED_EDGE_ALPHA, DIMMED_NODE_ALPHA, type SelectionEmphasis } from './graph-reducers'
import { buildChannelScales } from './channels/build-channel-scales'
import { MIN_EDGE_OPACITY, MAX_EDGE_OPACITY } from './channels/scales'
import { parseColor } from './color-alpha'
import { defaultChannelBindings } from './graph-store'
import { darkColors } from '../../theme/palette-dark'
import type { ChannelBindings } from '../../../shared/graph-view-types'
import type { GraphModel } from '../../../shared/graph-model-types'

function model(overrides?: Partial<GraphModel>): GraphModel {
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

const EMPTY_BINDINGS = defaultChannelBindings()

describe('createNodeReducer (unbound, child 05 cases)', () => {
  it('a document node is the default color', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const result = reducer('a', { kind: 'document', degree: 2, label: 'A' })
    expect(result.color).toBe(darkColors.graphNodeDefault)
    expect(result.type).toBe('circle')
    expect(result.label).toBe('A')
  })

  it('a dangling node is the dangling color and smaller', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const doc = reducer('doc', { kind: 'document', degree: 0, label: 'Doc' })
    const dangling = reducer('ghost', { kind: 'dangling', degree: 0, label: 'ghost' })
    expect(dangling.color).toBe(darkColors.graphNodeDangling)
    expect(dangling.size).toBeLessThan(doc.size)
  })

  it('preserves x/y (and other untouched attrs) from the input data', () => {
    // Sigma's nodeReducer contract: "this function must return a total
    // object and won't be merged" with the original graph attributes. A
    // reducer that builds a fresh object with only the visual fields drops
    // x/y silently in dev, then crashes Sigma's cache build the instant the
    // reducer is installed via setSetting — "could not find a valid
    // position (x, y) for node ...". This pins that x/y (and an arbitrary
    // passthrough attribute) survive the reducer.
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const result = reducer('a', { kind: 'document', degree: 2, label: 'A', x: 12.5, y: -7.25, community: 3 })
    expect(result.x).toBe(12.5)
    expect(result.y).toBe(-7.25)
    expect(result.community).toBe(3)
  })

  it('a group node uses the group color', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const result = reducer('group:topic:ops', { kind: 'group', degree: 2, label: 'ops' })
    expect(result.color).toBe(darkColors.graphNodeGroup)
  })

  it('a section node uses the section color and is smaller', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const doc = reducer('doc', { kind: 'document', degree: 1, label: 'Doc' })
    const section = reducer('doc#Intro', { kind: 'section', degree: 1, label: 'Intro' })
    expect(section.color).toBe(darkColors.graphNodeSection)
    expect(section.size).toBeLessThan(doc.size)
  })

  it('the selected node is highlighted', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', { selected: new Set(['a']), emphasis: new Set(['a']) })
    const result = reducer('a', { kind: 'document', degree: 0, label: 'A' })
    expect(result.highlighted).toBe(true)
    expect(result.zIndex).toBe(1)
  })

  it('overview LOD yields type point, and far out a leaf has no label', () => {
    const m = model({
      nodes: [
        { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false },
        { id: 'hub', kind: 'document', label: 'Hub', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 9, community: 0, centrality: 0, orphan: false },
      ],
    })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'overview', null, undefined, 'hull', undefined, 4)
    const result = reducer('a', { kind: 'document', degree: 0, label: 'A' })
    expect(result.type).toBe('point')
    expect(result.label).toBe('')
  })
})

describe('createEdgeReducer (unbound, child 05 cases)', () => {
  it('a directed edge is type arrow', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    const result = reducer('e1', { directed: true, dangling: false })
    expect(result.type).toBe('arrow')
    expect(result.color).toBe(darkColors.graphEdgeDefault)
  })

  it('an undirected edge is type line', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    const result = reducer('e1', { directed: false, dangling: false })
    expect(result.type).toBe('line')
  })

  it('a dangling edge uses the dangling edge color', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    const result = reducer('e1', { directed: false, dangling: true })
    expect(result.color).toBe(darkColors.graphEdgeDangling)
  })
})

describe('selection emphasis', () => {
  function chain() {
    return model({
      nodes: [docNode('a', {}), docNode('b', {}), docNode('c', {}), docNode('d', {})],
      edges: [
        { id: 'a|b', source: 'a', target: 'b', directed: false, origin: 'wikilink' as const, multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 },
        { id: 'c|d', source: 'c', target: 'd', directed: false, origin: 'wikilink' as const, multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 },
      ],
    })
  }
  const selectB: SelectionEmphasis = { selected: new Set(['b']), emphasis: new Set(['a', 'b']) }

  it('a node outside the emphasis set is dimmed and loses its label', () => {
    const m = chain()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', selectB)
    const dimmed = reducer('c', { kind: 'document', degree: 1, label: 'C' })
    const base = parseColor(darkColors.graphNodeDefault)!
    const bg = parseColor(darkColors.containerBg)!
    const got = parseColor(dimmed.color)!
    // Dimming darkens toward the stage background and stays OPAQUE. A
    // translucent dim stacks under sigma's premultiplied blend, which is
    // what made dense regions refuse to recede.
    expect(got.a).toBe(1)
    expect(got.r).toBeCloseTo(base.r + (bg.r - base.r) * (1 - DIMMED_NODE_ALPHA), 0)
    // Nearer the background than the colour it started from.
    expect(Math.abs(got.r - bg.r)).toBeLessThan(Math.abs(base.r - bg.r))
    expect(dimmed.label).toBe('')
    expect(dimmed.highlighted).toBeUndefined()
  })

  it('a neighbour of the selection keeps full strength and its label', () => {
    const m = chain()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', selectB)
    const kept = reducer('a', { kind: 'document', degree: 1, label: 'A' })
    expect(kept.color).toBe(darkColors.graphNodeDefault)
    expect(kept.label).toBe('A')
  })

  it('every selected node is highlighted in a multi-selection', () => {
    const m = chain()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', { selected: new Set(['a', 'd']), emphasis: new Set(['a', 'b', 'c', 'd']) })
    expect(reducer('a', { kind: 'document', degree: 1, label: 'A' }).highlighted).toBe(true)
    expect(reducer('d', { kind: 'document', degree: 1, label: 'D' }).highlighted).toBe(true)
    expect(reducer('b', { kind: 'document', degree: 1, label: 'B' }).highlighted).toBeUndefined()
  })

  it('an edge touching no selected node is dimmed; one touching the selection is not', () => {
    const m = chain()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors, selectB)
    const base = parseColor(darkColors.graphEdgeDefault)!
    const bg = parseColor(darkColors.containerBg)!
    const far = parseColor(reducer('c|d', { directed: false, dangling: false }).color)!
    // Opaque, and mixed toward the background: twenty of these crossing
    // compose to the same colour as one, instead of accumulating to ~96%
    // of full strength the way twenty translucent ones did.
    expect(far.a).toBe(1)
    expect(far.r).toBeCloseTo(base.r + (bg.r - base.r) * (1 - DIMMED_EDGE_ALPHA), 0)
    expect(reducer('a|b', { directed: false, dangling: false }).color).toBe(darkColors.graphEdgeDefault)
  })

  it('with no selection nothing is dimmed', () => {
    const m = chain()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const nodeReducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', { selected: new Set(), emphasis: new Set() })
    const edgeReducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors, { selected: new Set(), emphasis: new Set() })
    expect(nodeReducer('c', { kind: 'document', degree: 1, label: 'C' }).color).toBe(darkColors.graphNodeDefault)
    expect(edgeReducer('c|d', { directed: false, dangling: false }).color).toBe(darkColors.graphEdgeDefault)
  })
})

describe('pinned nodes', () => {
  it('a pinned node draws with the border program when the shape channel is unbound', () => {
    const m = model({ nodes: [docNode('a', {}), docNode('b', {})] })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null, undefined, 'hull', new Set(['a']))
    expect(reducer('a', { kind: 'document', degree: 1, label: 'A' }).type).toBe('border')
    expect(reducer('b', { kind: 'document', degree: 1, label: 'B' }).type).toBe('circle')
  })

  it('a bound shape channel keeps its encoding on a pinned node', () => {
    const m = model({ nodes: [docNode('a', { status: 'x' })] })
    const bindings: ChannelBindings = { ...EMPTY_BINDINGS, nodeShape: { dimension: { source: 'frontMatter', field: 'status' }, valueType: 'categorical' } }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null, undefined, 'hull', new Set(['a']))
    expect(reducer('a', { kind: 'document', degree: 1, label: 'A' }).type).toBe('circle')
  })

  it('overview LOD still draws a pinned node as a point', () => {
    const m = model({ nodes: [docNode('a', {})] })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'overview', null, undefined, 'hull', new Set(['a']))
    expect(reducer('a', { kind: 'document', degree: 1, label: 'A' }).type).toBe('point')
  })
})

describe('createEdgeReducer (edgeOpacity channel)', () => {
  function edge(id: string, source: string, target: string, multiplicity: number) {
    return { id, source, target, directed: false, origin: 'wikilink' as const, multiplicity, crossRoot: false, dangling: false, recencyMs: 0 }
  }
  const twoEdges = () => model({
    nodes: [docNode('a', {}), docNode('b', {}), docNode('c', {})],
    edges: [edge('e-low', 'a', 'b', 1), edge('e-high', 'b', 'c', 5)],
  })

  it('a bound opacity channel changes only the alpha of the resolved edge color', () => {
    const m = twoEdges()
    const bindings: ChannelBindings = { ...EMPTY_BINDINGS, edgeOpacity: { dimension: { source: 'edge', metric: 'multiplicity' }, valueType: 'numeric' } }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createEdgeReducer(m, scales, bindings, darkColors)

    const low = parseColor(reducer('e-low', { directed: false, dangling: false }).color)!
    const high = parseColor(reducer('e-high', { directed: false, dangling: false }).color)!
    const base = parseColor(darkColors.graphEdgeDefault)!

    expect([low.r, low.g, low.b]).toEqual([base.r, base.g, base.b])
    expect([high.r, high.g, high.b]).toEqual([base.r, base.g, base.b])
    expect(low.a).toBeCloseTo(MIN_EDGE_OPACITY, 3)
    expect(high.a).toBeCloseTo(MAX_EDGE_OPACITY, 3)
  })

  it('an unbound opacity channel leaves the palette color string untouched', () => {
    const m = twoEdges()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    expect(reducer('e-low', { directed: false, dangling: false }).color).toBe(darkColors.graphEdgeDefault)
  })

  it('an edge absent from the model (a coarsened synthetic edge) keeps the palette color', () => {
    const m = twoEdges()
    const bindings: ChannelBindings = { ...EMPTY_BINDINGS, edgeOpacity: { dimension: { source: 'edge', metric: 'multiplicity' }, valueType: 'numeric' } }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createEdgeReducer(m, scales, bindings, darkColors)
    expect(reducer('cluster:1|cluster:2', { directed: false, dangling: false }).color).toBe(darkColors.graphEdgeDefault)
  })

  it('the opacity scale resolves a missing value to the minimum opacity', () => {
    const m = twoEdges()
    const bindings: ChannelBindings = { ...EMPTY_BINDINGS, edgeOpacity: { dimension: { source: 'edge', metric: 'multiplicity' }, valueType: 'numeric' } }
    const scales = buildChannelScales(m, bindings, darkColors)
    expect(scales.edgeOpacity.apply(null)).toBe(MIN_EDGE_OPACITY)
  })

  it('opacity composes with a bound edge color', () => {
    const m = twoEdges()
    const bindings: ChannelBindings = {
      ...EMPTY_BINDINGS,
      edgeColor: { dimension: { source: 'edge', metric: 'multiplicity' }, valueType: 'categorical' },
      edgeOpacity: { dimension: { source: 'edge', metric: 'multiplicity' }, valueType: 'numeric' },
    }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createEdgeReducer(m, scales, bindings, darkColors)
    const colored = parseColor(String(scales.edgeColor.apply(1)))!
    const result = parseColor(reducer('e-low', { directed: false, dangling: false }).color)!
    expect([result.r, result.g, result.b]).toEqual([colored.r, colored.g, colored.b])
    expect(result.a).toBeCloseTo(MIN_EDGE_OPACITY, 3)
  })
})

function docNode(id: string, frontMatter: Record<string, unknown>, degree = 1) {
  return { id, kind: 'document' as const, label: id, frontMatter, sizeBytes: 0, modifiedMs: 0, degree, community: 0, centrality: 0, orphan: false }
}

describe('createNodeReducer (bound, child 06 cases)', () => {
  it('three channels bound to three different dimensions produce three independent facts on one node', () => {
    const m = model({
      nodes: [docNode('a', { status: 'active', category: 'ops' }, 4), docNode('b', { status: 'done', category: 'infra' }, 1)],
    })
    const bindings: ChannelBindings = {
      ...EMPTY_BINDINGS,
      nodeColor: { dimension: { source: 'frontMatter', field: 'status' }, valueType: 'categorical' },
      nodeShape: { dimension: { source: 'frontMatter', field: 'category' }, valueType: 'categorical' },
      nodeSize: { dimension: { source: 'structural', metric: 'degree' }, valueType: 'numeric' },
    }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null)

    const a = reducer('a', { kind: 'document', degree: 4, label: 'a' })
    const b = reducer('b', { kind: 'document', degree: 1, label: 'b' })

    // Color differs by status, independent of shape (which differs by category).
    expect(a.color).not.toBe(b.color)
    expect(a.type).not.toBe(b.type)
    // Size scales with degree: a (degree 4) is larger than b (degree 1).
    expect(a.size).toBeGreaterThan(b.size)
  })

  it('a document missing the bound color field renders the unknown gray', () => {
    const m = model({ nodes: [docNode('a', { status: 'active' }), docNode('b', {})] })
    const bindings: ChannelBindings = {
      ...EMPTY_BINDINGS,
      nodeColor: { dimension: { source: 'frontMatter', field: 'status' }, valueType: 'categorical' },
    }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null)
    const b = reducer('b', { kind: 'document', degree: 0, label: 'b' })
    expect(b.color).toBe(darkColors.graphUnknown)
  })

  it('rebinding a channel changes the appearance without needing a model rebuild', () => {
    const m = model({ nodes: [docNode('a', { status: 'active', priority: 'high' })] })
    const bindingsA: ChannelBindings = {
      ...EMPTY_BINDINGS,
      nodeColor: { dimension: { source: 'frontMatter', field: 'status' }, valueType: 'categorical' },
    }
    const bindingsB: ChannelBindings = {
      ...EMPTY_BINDINGS,
      nodeColor: { dimension: { source: 'frontMatter', field: 'priority' }, valueType: 'categorical' },
    }
    const scalesA = buildChannelScales(m, bindingsA, darkColors)
    const scalesB = buildChannelScales(m, bindingsB, darkColors)
    const reducerA = createNodeReducer(m, scalesA, bindingsA, darkColors, 'detail', null)
    const reducerB = createNodeReducer(m, scalesB, bindingsB, darkColors, 'detail', null)
    // Both resolve to a real (non-unknown) color since each field is present on the one node.
    expect(reducerA('a', { kind: 'document', degree: 0, label: 'a' }).color).not.toBe(darkColors.graphUnknown)
    expect(reducerB('a', { kind: 'document', degree: 0, label: 'a' }).color).not.toBe(darkColors.graphUnknown)
  })
})

describe('reducer lookup cost', () => {
  // Regression: the reducers resolved a node and an edge with
  // `Array.find`, so each call was O(n) and a full Sigma refresh — one per
  // graph mutation, and coarsening performs thousands at once — was O(n²).
  // On a corpus of a couple of thousand nodes that is roughly fourteen
  // million comparisons per refresh on the main thread, which locked the
  // app when zooming out far enough to trigger coarsening.
  //
  // Direction: restore the `find` and this goes from milliseconds to tens
  // of seconds.
  it('resolves every node and edge in a large corpus in linear time', () => {
    const count = 20000
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      kind: 'document' as const,
      label: `n${i}`,
      frontMatter: {},
      sizeBytes: 0,
      modifiedMs: 0,
      degree: 1,
      community: i % 20,
      centrality: 0,
      orphan: false,
    }))
    const edges = Array.from({ length: count }, (_, i) => ({
      id: `e${i}`,
      source: `n${i}`,
      target: `n${(i + 1) % count}`,
      directed: true,
      origin: 'wikilink' as const,
      multiplicity: 1,
      crossRoot: false,
      dangling: false,
      recencyMs: 0,
    }))
    const m = model({ nodes, edges })
    const bindings = defaultChannelBindings()
    const scales = buildChannelScales(m, bindings, darkColors)

    const nodeReducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null)
    const edgeReducer = createEdgeReducer(m, scales, bindings, darkColors)

    const startedAt = Date.now()
    for (const node of nodes) nodeReducer(node.id, { x: 0, y: 0, label: node.label, kind: node.kind, degree: node.degree })
    for (const edge of edges) edgeReducer(edge.id, { directed: true })
    const elapsedMs = Date.now() - startedAt

    // Deliberately generous — this pins a complexity class, not a
    // wall-clock budget. Indexed, this is a few milliseconds; with the
    // linear scan it is hundreds of millions of comparisons and takes
    // seconds.
    expect(elapsedMs).toBeLessThan(1000)
  })
})

describe('node-mediated edges are drawn on demand', () => {
  /**
   * Regression: turning tag nodes on added 112 nodes and 15,968 edges to a
   * 2,192-document corpus — six times its own link count — and the stage
   * rendered as one white mass. The shared node stays as an attractor (the
   * edges remain in the graph, so the simulation still clusters its
   * members); only the lines wait to be asked for.
   */
  function edge(id: string, source: string, target: string, origin: 'wikilink' | 'group' | 'anchor' | 'section') {
    return { id, source, target, directed: false, origin, multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 }
  }
  const m = () => model({
    nodes: [docNode('doc', {}), docNode('other', {})],
    edges: [
      edge('curated', 'doc', 'other', 'wikilink'),
      edge('tag', 'topic/x', 'doc', 'group'),
      edge('anchor', 'anchor:owner:team/x', 'doc', 'anchor'),
      edge('section', 'doc', 'doc#Intro#1', 'section'),
    ],
  })

  function reduce(edgeId: string, selection: SelectionEmphasis | null) {
    const built = m()
    const scales = buildChannelScales(built, EMPTY_BINDINGS, darkColors)
    return createEdgeReducer(built, scales, EMPTY_BINDINGS, darkColors, selection)(edgeId, { directed: false, dangling: false })
  }

  const seeded = (ids: string[]): SelectionEmphasis => ({ selected: new Set(ids), emphasis: new Set(ids) })

  it('with nothing selected or hovered, no membership line draws', () => {
    expect(reduce('tag', null).hidden).toBe(true)
    expect(reduce('anchor', null).hidden).toBe(true)
  })

  it('a curated document link always draws — it is an author\'s own claim', () => {
    expect(reduce('curated', null).hidden).toBeUndefined()
    expect(reduce('curated', seeded(['other'])).hidden).toBeUndefined()
  })

  it('a document\'s tie to its own section always draws — it is structural, not a star', () => {
    expect(reduce('section', null).hidden).toBeUndefined()
  })

  it('seeding the shared node reveals everything it gathers', () => {
    expect(reduce('tag', seeded(['topic/x'])).hidden).toBeUndefined()
    expect(reduce('anchor', seeded(['anchor:owner:team/x'])).hidden).toBeUndefined()
  })

  it('seeding a document reveals which shared nodes claim it', () => {
    expect(reduce('tag', seeded(['doc'])).hidden).toBeUndefined()
  })

  it('seeding an unrelated node reveals nothing', () => {
    expect(reduce('tag', seeded(['other'])).hidden).toBe(true)
  })
})

describe('dimming does not stack in dense regions', () => {
  /**
   * Regression, and the whole reason dimming stopped using alpha.
   *
   * Sigma blends premultiplied (`gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)`),
   * so N translucent lines over one pixel compose to `1 - (1-a)^N` of the
   * colour. At the old 15% dim, twenty crossing edges reached ~96% — as
   * bright as an undimmed edge. Hovering one node in a 2,207-node corpus
   * emphasised 6% of it and yet appeared to light the whole graph, because
   * every dense cluster failed to recede.
   *
   * An opaque dim cannot do that: the twentieth line writes the same value
   * as the first.
   */
  function composite(color: string, layers: number, bg: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
    const c = parseColor(color)!
    let out = { ...bg }
    for (let i = 0; i < layers; i++) {
      out = {
        r: c.r * c.a + out.r * (1 - c.a),
        g: c.g * c.a + out.g * (1 - c.a),
        b: c.b * c.a + out.b * (1 - c.a),
      }
    }
    return out
  }

  it('twenty stacked dimmed edges look exactly like one', () => {
    const m = model({
      nodes: [docNode('a', {}), docNode('b', {}), docNode('s', {})],
      edges: [{ id: 'a|b', source: 'a', target: 'b', directed: false, origin: 'wikilink' as const, multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 }],
    })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors, { selected: new Set(['s']), emphasis: new Set(['s']) })
    const dimmed = reducer('a|b', { directed: false, dangling: false }).color
    const bg = parseColor(darkColors.containerBg)!

    const one = composite(dimmed, 1, bg)
    const twenty = composite(dimmed, 20, bg)
    expect(twenty.r).toBeCloseTo(one.r, 5)
    expect(twenty.g).toBeCloseTo(one.g, 5)
    expect(twenty.b).toBeCloseTo(one.b, 5)
  })

  it('a stack of dimmed edges stays darker than a lit one', () => {
    const m = model({
      nodes: [docNode('a', {}), docNode('b', {}), docNode('s', {})],
      edges: [{ id: 'a|b', source: 'a', target: 'b', directed: false, origin: 'wikilink' as const, multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 }],
    })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors, { selected: new Set(['s']), emphasis: new Set(['s']) })
    const bg = parseColor(darkColors.containerBg)!
    const lit = parseColor(darkColors.graphEdgeDefault)!
    const stacked = composite(reducer('a|b', { directed: false, dangling: false }).color, 20, bg)
    // The distance from the background is what "brightness" means on this
    // stage; twenty dimmed edges must not reach a lit one.
    expect(Math.abs(stacked.r - bg.r)).toBeLessThan(Math.abs(lit.r - bg.r))
  })
})
