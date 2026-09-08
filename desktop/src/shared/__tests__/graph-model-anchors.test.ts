/**
 * Anchor nodes: a promoted note-descriptive property drawn as cluster
 * centres, with the two guards the requirement makes mandatory — a
 * hierarchy depth cut and cardinality suppression of degenerate values.
 */
import { describe, expect, it } from 'vitest'
import { anchorValue, buildAnchorNodes } from '../graph-model-anchors'
import { buildGraphModel } from '../graph-model'
import { resolveIdentities } from '../graph-model-resolve'
import { GRAPH_VIEW_DEFAULTS, type GraphViewConfig } from '../graph-view-types'
import type { CorpusDocument, CorpusSnapshot } from '../graph-corpus-types'

function doc(partial: Partial<CorpusDocument> & { path: string }): CorpusDocument {
  return {
    rootPath: '/root',
    fileName: partial.path.split('/').pop()!.replace(/\.md$/i, ''),
    frontMatter: {},
    wikiLinks: [],
    markdownLinks: [],
    sections: [],
    sizeBytes: 100,
    modifiedMs: 1000,
    ...partial,
  }
}

function config(overrides?: Partial<GraphViewConfig>): GraphViewConfig {
  return {
    corpusRoots: [],
    identityField: GRAPH_VIEW_DEFAULTS.identityField,
    labelField: GRAPH_VIEW_DEFAULTS.labelField,
    tagField: GRAPH_VIEW_DEFAULTS.tagField,
    groupFields: GRAPH_VIEW_DEFAULTS.groupFields,
    edgeFields: GRAPH_VIEW_DEFAULTS.edgeFields,
    hoverFields: GRAPH_VIEW_DEFAULTS.hoverFields,
    curatedFields: [],
    promotedFields: [],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
    ...overrides,
  }
}

describe('anchorValue', () => {
  it('keeps the whole value with no depth', () => {
    expect(anchorValue('sections/staff/journal', { field: 'x' })).toBe('sections/staff/journal')
  })
  it('cuts a hierarchical value to the configured depth', () => {
    expect(anchorValue('sections/staff/journal', { field: 'x', depth: 2 })).toBe('sections/staff')
    expect(anchorValue('sections', { field: 'x', depth: 3 })).toBe('sections')
  })
  it('splits a delimited value and anchors on one segment', () => {
    const orn = 'orn:com.dcim:note:project/dci-orion:projects/dci-orion/README'
    expect(anchorValue(orn, { field: 'orn', split: { separator: ':', index: 3 } })).toBe('project/dci-orion')
    expect(anchorValue(orn, { field: 'orn', split: { separator: ':', index: 3 }, depth: 1 })).toBe('project')
    expect(anchorValue('a:b', { field: 'orn', split: { separator: ':', index: 5 } })).toBeNull()
  })
})

describe('buildAnchorNodes', () => {
  const documents = [
    doc({ path: '/root/sections/staff/a.md', frontMatter: { id: 'a', owner: 'team/alpha' } }),
    doc({ path: '/root/sections/staff/b.md', frontMatter: { id: 'b', owner: 'team/alpha' } }),
    doc({ path: '/root/sections/strategy/c.md', frontMatter: { id: 'c', owner: 'team/beta' } }),
    doc({ path: '/root/sections/strategy/d.md', frontMatter: { id: 'd', owner: 'team/beta' } }),
    doc({ path: '/root/projects/x/e.md', frontMatter: { id: 'e', owner: 'team/solo' } }),
  ]

  it('draws nothing for a promoted field the view has not turned on', () => {
    const cfg = config({ promotedFields: [{ field: 'owner' }] })
    const { idByPath } = resolveIdentities(documents, cfg)
    expect(buildAnchorNodes(documents, cfg, idByPath, new Set()).nodes).toEqual([])
  })

  it('gathers documents under one anchor per value and suppresses a singleton', () => {
    const cfg = config({ promotedFields: [{ field: 'owner' }] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const result = buildAnchorNodes(documents, cfg, idByPath, new Set(['owner']))
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['anchor:owner:team/alpha', 'anchor:owner:team/beta'])
    expect(result.nodes.every((n) => n.kind === 'anchor')).toBe(true)
    expect(result.memberships.filter((m) => m.anchorId === 'anchor:owner:team/alpha').map((m) => m.docId).sort()).toEqual(['a', 'b'])
    expect(result.suppressions).toEqual([{ field: 'owner', value: 'team/solo', documentCount: 1, reason: 'singleton' }])
  })

  it('suppresses a property whose values collapse to one hub at the chosen depth', () => {
    const cfg = config({ promotedFields: [{ field: 'owner', depth: 1 }] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const result = buildAnchorNodes(documents, cfg, idByPath, new Set(['owner']))
    expect(result.nodes).toEqual([])
    expect(result.suppressions).toEqual([{ field: 'owner', value: null, documentCount: 5, reason: 'degenerate-property' }])
  })

  it('suppresses a hub value and keeps the discriminating ones', () => {
    const many = Array.from({ length: 20 }, (_, i) => doc({ path: `/root/${i}.md`, frontMatter: { id: `n${i}`, kind: i < 2 ? 'rare' : 'common' } }))
    const cfg = config({ promotedFields: [{ field: 'kind' }] })
    const { idByPath } = resolveIdentities(many, cfg)
    const result = buildAnchorNodes(many, cfg, idByPath, new Set(['kind']))
    expect(result.nodes.map((n) => n.id)).toEqual(['anchor:kind:rare'])
    expect(result.suppressions).toEqual([{ field: 'kind', value: 'common', documentCount: 18, reason: 'hub' }])
  })

  it('promotes the document location relative to its root at a depth', () => {
    const cfg = config({ promotedFields: [{ field: 'path', depth: 2 }] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const result = buildAnchorNodes(documents, cfg, idByPath, new Set(['path']))
    expect(result.nodes.map((n) => n.label).sort()).toEqual(['sections/staff', 'sections/strategy'])
    expect(result.suppressions).toEqual([{ field: 'path', value: 'projects/x', documentCount: 1, reason: 'singleton' }])
  })

  it('is wired through buildGraphModel as anchor edges and suppressions', () => {
    const cfg = config({ promotedFields: [{ field: 'owner' }] })
    const snapshot: CorpusSnapshot = { revision: 1, roots: [{ path: '/root', exists: true, documentCount: 5 }], documents }
    const { model } = buildGraphModel(snapshot, cfg, undefined, { promotedFields: new Set(['owner']) })
    const anchorEdges = model.edges.filter((e) => e.origin === 'anchor')
    expect(anchorEdges).toHaveLength(4)
    expect(anchorEdges[0].field).toBe('owner')
    expect(model.anchorSuppressions).toHaveLength(1)
    // Off by default: the same corpus without the option draws no anchor.
    expect(buildGraphModel(snapshot, cfg).model.nodes.some((n) => n.kind === 'anchor')).toBe(false)
  })
})
