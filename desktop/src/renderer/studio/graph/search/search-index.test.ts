/**
 * Tests for search-index.ts (child 07): match by label, identity, path;
 * case-insensitive; ranking order; a filtered-out node is still found
 * (this module never consults visibility).
 */
import { describe, expect, it } from 'vitest'
import { buildSearchIndex, query } from './search-index'
import type { GraphModel, GraphNode } from '../../../../shared/graph-model-types'

function node(id: string, label: string, path?: string): GraphNode {
  return { id, kind: 'document', label, path, frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false }
}

function model(nodes: GraphNode[]): GraphModel {
  return { nodes, edges: [], dangling: [], anchorSuppressions: [], discoveredFields: [], identityCollisions: [], centralityMethod: 'degree' }
}

describe('buildSearchIndex / query', () => {
  it('matches by label', () => {
    const index = buildSearchIndex(model([node('a', 'Alpha Doc')]))
    expect(query(index, 'alpha').map((r) => r.id)).toEqual(['a'])
  })

  it('matches by identity', () => {
    const index = buildSearchIndex(model([node('special-id', 'Something Else')]))
    expect(query(index, 'special-id').map((r) => r.id)).toEqual(['special-id'])
  })

  it('matches by path', () => {
    const index = buildSearchIndex(model([node('a', 'A', '/root/notes/deep.md')]))
    expect(query(index, 'deep').map((r) => r.id)).toEqual(['a'])
  })

  it('is case-insensitive', () => {
    const index = buildSearchIndex(model([node('a', 'Alpha Doc')]))
    expect(query(index, 'ALPHA').map((r) => r.id)).toEqual(['a'])
  })

  it('ranks a label prefix match above a label substring match', () => {
    const index = buildSearchIndex(model([node('a', 'Zeta Alpha'), node('b', 'Alpha Zeta')]))
    const results = query(index, 'alpha')
    expect(results[0].id).toBe('b') // prefix match ranks first
  })

  it('an empty query returns no results', () => {
    const index = buildSearchIndex(model([node('a', 'Alpha')]))
    expect(query(index, '  ')).toEqual([])
  })

  it('a node not currently visible (filtered out) is still found — this module ignores visibility entirely', () => {
    // The search index has no concept of visibility at all; it is built
    // from the full model, so there is nothing to "un-filter" here.
    const index = buildSearchIndex(model([node('hidden', 'Hidden Doc')]))
    expect(query(index, 'hidden').map((r) => r.id)).toEqual(['hidden'])
  })
})
