// @vitest-environment jsdom
/**
 * Tests for graph-reducers.ts, the presentation half: cluster visibility,
 * label priority and node outline, and orphan recession. The reducer-output
 * cases per node kind, edge direction, and bound channel live in
 * `graph-reducers.test.ts`; this file is the split that keeps both under
 * the size cap.
 */
import { describe, expect, it } from 'vitest'
import { createEdgeReducer, createNodeReducer, DIMMED_NODE_ALPHA, ORPHAN_ALPHA, type SelectionEmphasis } from './graph-reducers'
import { buildChannelScales } from './channels/build-channel-scales'
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

describe('cluster visibility', () => {
  // Regression: a synthetic cluster node has no model entry, so it is not
  // in the visibility set. Testing it against that set hid every collapsed
  // community outright — zooming out past the coarsening threshold made
  // most of the corpus vanish instead of summarising it.
  it('never hides a cluster node for being absent from the visibility set', () => {
    const m = model()
    const bindings = defaultChannelBindings()
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null, new Set(['some-real-node']))

    const cluster = reducer('cluster:3', { x: 0, y: 0, label: '12 documents', kind: 'cluster', degree: 0, memberCount: 12 })
    expect(cluster.hidden).toBe(false)
  })

  it('still hides an ordinary node that is filtered out', () => {
    const m = model()
    const bindings = defaultChannelBindings()
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null, new Set(['visible']))

    expect(reducer('visible', { x: 0, y: 0, label: 'v', kind: 'document', degree: 1 }).hidden).toBe(false)
    expect(reducer('filtered', { x: 0, y: 0, label: 'f', kind: 'document', degree: 1 }).hidden).toBe(true)
  })

  it('sizes a cluster by its member count, not its zero degree', () => {
    const m = model()
    const bindings = defaultChannelBindings()
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null)

    const small = reducer('cluster:1', { x: 0, y: 0, label: '', kind: 'cluster', degree: 0, memberCount: 3 })
    const large = reducer('cluster:2', { x: 0, y: 0, label: '', kind: 'cluster', degree: 0, memberCount: 300 })
    expect(large.size).toBeGreaterThan(small.size)
  })
})

describe('label priority and outline', () => {
  /** Ten leaves and two hubs, so the hub threshold has something to separate. */
  function skewed(): GraphModel {
    const nodes = [
      ...Array.from({ length: 40 }, (_, i) => ({ id: `leaf${i}`, kind: 'document' as const, label: `Leaf ${i}`, frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false })),
      { id: 'hub', kind: 'document' as const, label: 'Hub', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 30, community: 0, centrality: 0, orphan: false },
      { id: 'hub2', kind: 'document' as const, label: 'Hub 2', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 25, community: 0, centrality: 0, orphan: false },
    ]
    return model({ nodes })
  }

  it('far out only the best-connected few are labelled, forced past the grid; a leaf loses its label', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'overview', null, undefined, 'hull', undefined, 4)
    const hub = reducer('hub', { kind: 'document', degree: 30, label: 'Hub' })
    const leaf = reducer('leaf0', { kind: 'document', degree: 1, label: 'Leaf 0' })
    expect(hub.label).toBe('Hub')
    expect(hub.forceLabel).toBe(true)
    expect(hub.labelTier).toBe('hub')
    expect(leaf.label).toBe('')
    expect(leaf.forceLabel).toBe(false)
    expect(leaf.labelTier).toBe('normal')
  })

  it('the far-out budget shrinks with zoom until one landmark is left', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'overview', null, undefined, 'hull', undefined, 16)
    expect(reducer('hub', { kind: 'document', degree: 30, label: 'Hub' }).label).toBe('Hub')
    expect(reducer('hub2', { kind: 'document', degree: 25, label: 'Hub 2' }).label).toBe('')
  })

  it('between zoom 1 and the overview the candidates thin by rank, so the grid cannot crowd the stage', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    // 42 nodes at zoom 2: 42 / 4 = 10 candidates, raised to the landmark floor of 12.
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null, undefined, 'hull', undefined, 2)
    expect(reducer('hub', { kind: 'document', degree: 30, label: 'Hub' }).label).toBe('Hub')
    expect(reducer('leaf39', { kind: 'document', degree: 1, label: 'Leaf 39' }).label).toBe('')
  })

  it('a collapsed cluster is always a label candidate', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'overview', null, undefined, 'hull', undefined, 16)
    expect(reducer('cluster:1', { kind: 'cluster', degree: 0, memberCount: 40, label: 'Community 1' }).label).toBe('Community 1')
  })

  it('at detail zoom a leaf is labelled but not forced, so the grid budget still applies', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const leaf = reducer('leaf0', { kind: 'document', degree: 1, label: 'Leaf 0' })
    expect(leaf.label).toBe('Leaf 0')
    expect(leaf.forceLabel).toBe(false)
    // The top landmarks are forced; a hub outside that set relies on its size winning its cell.
    expect(reducer('hub', { kind: 'document', degree: 30, label: 'Hub' }).forceLabel).toBe(true)
  })

  it('a dimmed hub loses its forced label with its label', () => {
    const m = skewed()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const selection: SelectionEmphasis = { selected: new Set(['leaf0']), emphasis: new Set(['leaf0']) }
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', selection)
    const hub = reducer('hub', { kind: 'document', degree: 30, label: 'Hub' })
    expect(hub.label).toBe('')
    expect(hub.forceLabel).toBe(false)
  })

  it('every node carries the outline colour the outlined circle program reads', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    expect(reducer('a', { kind: 'document', degree: 2, label: 'A' }).outlineColor).toBe(darkColors.graphNodeOutline)
  })

  it('a pinned node rings in the hub label colour; border-tint rings in the community colour', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const pinned = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null, undefined, 'hull', new Set(['a']))
    expect(pinned('a', { kind: 'document', degree: 1, label: 'A', community: 2 }).ringColor).toBe(darkColors.graphLabelHub)
    const tinted = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null, undefined, 'border-tint')
    expect(tinted('a', { kind: 'document', degree: 1, label: 'A', community: 2 }).ringColor).toBe(darkColors.graphCategorical3)
  })

  it('a lone edge is straight; a reciprocal or parallel pair curves so the two lines read as two', () => {
    const m = model({
      nodes: [
        { id: 'a', kind: 'document', label: 'A', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 2, community: 0, centrality: 0, orphan: false },
        { id: 'b', kind: 'document', label: 'B', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 2, community: 0, centrality: 0, orphan: false },
        { id: 'c', kind: 'document', label: 'C', frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 1, community: 0, centrality: 0, orphan: false },
      ],
      edges: [
        { id: 'ab', source: 'a', target: 'b', directed: true, origin: 'front-matter', field: 'supersedes', multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 },
        { id: 'ba', source: 'b', target: 'a', directed: false, origin: 'wikilink', multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 },
        { id: 'ac', source: 'a', target: 'c', directed: false, origin: 'wikilink', multiplicity: 1, crossRoot: false, dangling: false, recencyMs: 0 },
      ],
    })
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    const lone = reducer('ac', { directed: false })
    expect(lone.type).toBe('line')
    expect(lone.curvature).toBe(0)
    const pairArrow = reducer('ab', { directed: true })
    expect(pairArrow.type).toBe('curvedArrow')
    expect(pairArrow.curvature).toBeGreaterThan(0)
    expect(reducer('ba', { directed: false }).type).toBe('curve')
  })

  it('a node-mediated edge draws a step fainter than a curated link, and both are opaque', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createEdgeReducer(m, scales, EMPTY_BINDINGS, darkColors)
    const curated = reducer('x', { directed: false, origin: 'wikilink' })
    const mediated = reducer('y', { directed: false, origin: 'group' })
    const anchored = reducer('z', { directed: false, origin: 'anchor' })
    expect(curated.color).toBe(darkColors.graphEdgeDefault)
    expect(mediated.color).toBe(darkColors.graphEdgeMediated)
    expect(anchored.color).toBe(darkColors.graphEdgeMediated)
    // Opaque by design: twenty edges over one pixel are as bright as one.
    expect(parseColor(curated.color)!.a).toBe(1)
    expect(parseColor(mediated.color)!.a).toBe(1)
  })

  it('an anchor node is a third visual class: its own colour and a square', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const anchor = reducer('anchor:owner:team', { kind: 'anchor', degree: 4, label: 'team' })
    const group = reducer('group:tags:x', { kind: 'group', degree: 4, label: 'x' })
    expect(anchor.color).toBe(darkColors.graphNodeAnchor)
    expect(anchor.type).toBe('square')
    expect(group.type).toBe('circle')
    expect(anchor.color).not.toBe(group.color)
  })

  it('eased levels dim a node partway and drop its label once it is more dimmed than lit', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const levels = { active: () => true, node: (id: string) => (id === 'half' ? 0.75 : id === 'mostly' ? 0.2 : 1), seed: () => 0 }
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', { selected: new Set(['s']), emphasis: new Set(['s']), levels })
    const half = reducer('half', { kind: 'document', degree: 1, label: 'Half' })
    const mostly = reducer('mostly', { kind: 'document', degree: 1, label: 'Mostly' })
    const lit = reducer('lit', { kind: 'document', degree: 1, label: 'Lit' })
    // Each step recedes toward the stage background rather than losing
    // alpha, so a partly-faded node is between the colour and the
    // background — and always opaque.
    const base = parseColor(darkColors.graphNodeDefault)!
    const bg = parseColor(darkColors.containerBg)!
    const towards = (keep: number): number => base.r + (bg.r - base.r) * (1 - keep)
    expect(parseColor(half.color)!.a).toBe(1)
    expect(parseColor(half.color)!.r).toBeCloseTo(towards(DIMMED_NODE_ALPHA + (1 - DIMMED_NODE_ALPHA) * 0.75), 0)
    expect(half.label).toBe('Half')
    expect(parseColor(mostly.color)!.r).toBeCloseTo(towards(DIMMED_NODE_ALPHA + (1 - DIMMED_NODE_ALPHA) * 0.2), 0)
    // More dimmed reads as nearer the background than less dimmed.
    expect(Math.abs(parseColor(mostly.color)!.r - bg.r)).toBeLessThan(Math.abs(parseColor(half.color)!.r - bg.r))
    expect(mostly.label).toBe('')
    expect(lit.color).toBe(darkColors.graphNodeDefault)
  })
})

describe('orphans recede', () => {
  it('an orphan document draws smaller and fainter than a linked one of the same degree', () => {
    const m = model()
    const scales = buildChannelScales(m, EMPTY_BINDINGS, darkColors)
    const reducer = createNodeReducer(m, scales, EMPTY_BINDINGS, darkColors, 'detail', null)
    const linked = reducer('a', { kind: 'document', degree: 0, label: 'A', orphan: false })
    const orphan = reducer('b', { kind: 'document', degree: 0, label: 'B', orphan: true })
    expect(orphan.size).toBeLessThan(linked.size)
    const l = parseColor(linked.color)!
    const o = parseColor(orphan.color)!
    const bg = parseColor(darkColors.containerBg)!
    // Fainter means nearer the stage background, at full opacity: an
    // orphan drawn translucent would brighten wherever orphans cluster.
    expect(o.a).toBe(1)
    expect(Math.abs(o.r - bg.r)).toBeLessThan(Math.abs(l.r - bg.r))
  })

  it('a bound colour still reads through on an orphan', () => {
    const m = model({
      nodes: [{ id: 'b', kind: 'document', label: 'B', frontMatter: { type: 'note' }, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true }],
      discoveredFields: ['type'],
    })
    const bindings: ChannelBindings = { ...EMPTY_BINDINGS, nodeColor: { dimension: { source: 'frontMatter', field: 'type' }, valueType: 'categorical' } }
    const scales = buildChannelScales(m, bindings, darkColors)
    const reducer = createNodeReducer(m, scales, bindings, darkColors, 'detail', null)
    const bound = parseColor(String(scales.nodeColor.apply('note')))!
    const o = parseColor(reducer('b', { kind: 'document', degree: 0, label: 'B', orphan: true }).color)!
    const bg = parseColor(darkColors.containerBg)!
    const grey = parseColor(darkColors.graphNodeDefault)!
    // The bound hue still reads: the orphan sits between ITS OWN colour and
    // the background, not between the default grey and the background.
    expect(o.r).toBeCloseTo(bound.r + (bg.r - bound.r) * (1 - ORPHAN_ALPHA), 0)
    expect(o.g).toBeCloseTo(bound.g + (bg.g - bound.g) * (1 - ORPHAN_ALPHA), 0)
    expect(o.b).toBeCloseTo(bound.b + (bg.b - bound.b) * (1 - ORPHAN_ALPHA), 0)
    // Not simply the default node colour faded.
    expect(o.b).not.toBeCloseTo(grey.b + (bg.b - grey.b) * (1 - ORPHAN_ALPHA), 0)
  })
})
