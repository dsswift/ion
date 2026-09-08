/**
 * Tests for dimension-catalog.ts (child 06): structural/mechanical
 * families always present, discovered fields all appear, a curated
 * `hidden` field is absent from the catalog but still present in the
 * model, and curated `displayName`/`order` apply.
 */
import { describe, expect, it } from 'vitest'
import { buildDimensionCatalog } from './dimension-catalog'
import type { GraphModel } from '../../../../shared/graph-model-types'
import type { GraphViewCuratedField } from '../../../../shared/graph-view-types'

function model(discoveredFields: string[]): GraphModel {
  return {
    nodes: [
      { id: 'a', kind: 'document', label: 'A', frontMatter: { topic: 'ops' }, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: true },
    ],
    edges: [],
    dangling: [],
    anchorSuppressions: [],
    discoveredFields,
    identityCollisions: [],
    centralityMethod: 'degree',
  }
}

describe('buildDimensionCatalog (node)', () => {
  it('structural and mechanical families are always present', () => {
    const catalog = buildDimensionCatalog(model([]), [], 'node')
    const families = new Set(catalog.map((e) => e.family))
    expect(families.has('structural')).toBe(true)
    expect(families.has('mechanical')).toBe(true)
  })

  it('every discovered field appears', () => {
    const catalog = buildDimensionCatalog(model(['topic', 'status']), [], 'node')
    const fields = catalog.filter((e) => e.dimension.source === 'frontMatter').map((e) => (e.dimension as { field: string }).field)
    expect(fields.sort()).toEqual(['status', 'topic'])
  })

  it('a curated hidden field is absent from the catalog', () => {
    const curated: GraphViewCuratedField[] = [{ field: 'topic', hidden: true }]
    const catalog = buildDimensionCatalog(model(['topic', 'status']), curated, 'node')
    const fields = catalog.filter((e) => e.dimension.source === 'frontMatter').map((e) => (e.dimension as { field: string }).field)
    expect(fields).not.toContain('topic')
    expect(fields).toContain('status')
  })

  it('a curated hidden field is still present in the model', () => {
    const m = model(['topic'])
    expect(m.nodes[0].frontMatter.topic).toBe('ops')
  })

  it('curated displayName and order apply', () => {
    const curated: GraphViewCuratedField[] = [{ field: 'topic', displayName: 'Topic Area', order: 0 }]
    const catalog = buildDimensionCatalog(model(['topic']), curated, 'node')
    const entry = catalog.find((e) => e.dimension.source === 'frontMatter' && (e.dimension as { field: string }).field === 'topic')
    expect(entry?.displayName).toBe('Topic Area')
    expect(entry?.order).toBe(0)
  })
})

describe('buildDimensionCatalog (edge)', () => {
  it('edge family entries are always present, node-only families absent', () => {
    const catalog = buildDimensionCatalog(model([]), [], 'edge')
    const families = new Set(catalog.map((e) => e.family))
    expect(families.has('edge')).toBe(true)
    expect(families.has('structural')).toBe(false)
    expect(families.has('mechanical')).toBe(false)
  })
})

describe('tag treatment governs whether the tag field is offered', () => {
  // The three treatments must differ. 'off' means no tag involvement in the
  // graph, which includes the binding and filter catalog: offering the field
  // anyway made 'off' and 'filter' the same setting under two names.
  it("'off' excludes the tag field from the catalog", () => {
    const catalog = buildDimensionCatalog(model(['tags', 'type']), [], 'node', { tagField: 'tags', tagTreatment: 'off' })
    expect(catalog.some((e) => e.dimension.source === 'frontMatter' && e.dimension.field === 'tags')).toBe(false)
    expect(catalog.some((e) => e.dimension.source === 'frontMatter' && e.dimension.field === 'type')).toBe(true)
  })

  it("'filter' offers the tag field", () => {
    const catalog = buildDimensionCatalog(model(['tags']), [], 'node', { tagField: 'tags', tagTreatment: 'filter' })
    expect(catalog.some((e) => e.dimension.source === 'frontMatter' && e.dimension.field === 'tags')).toBe(true)
  })

  it("'nodes' offers the tag field, which is also grouped on the canvas", () => {
    const catalog = buildDimensionCatalog(model(['tags']), [], 'node', { tagField: 'tags', tagTreatment: 'nodes' })
    expect(catalog.some((e) => e.dimension.source === 'frontMatter' && e.dimension.field === 'tags')).toBe(true)
  })

  it('omitting the treatment offers every discovered field, as before', () => {
    const catalog = buildDimensionCatalog(model(['tags']), [], 'node')
    expect(catalog.some((e) => e.dimension.source === 'frontMatter' && e.dimension.field === 'tags')).toBe(true)
  })
})
