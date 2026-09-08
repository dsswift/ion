/**
 * Tests for filter-rules.ts (child 07): include/exclude are exact inverses,
 * an empty-value exclude is inert, numeric bounds are inclusive, and a
 * missing value fails an include but passes an exclude.
 */
import { describe, expect, it } from 'vitest'
import { matchesRule, passesFilters } from './filter-rules'
import type { GraphFilterRule } from '../../../../shared/graph-view-types'
import type { GraphModel, GraphNode } from '../../../../shared/graph-model-types'

function node(frontMatter: Record<string, unknown>): GraphNode {
  return { id: 'a', kind: 'document', label: 'a', frontMatter, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false }
}

function model(): GraphModel {
  return { nodes: [], edges: [], dangling: [], anchorSuppressions: [], discoveredFields: [], identityCollisions: [], centralityMethod: 'degree' }
}

describe('matchesRule', () => {
  it('include and exclude on the same dimension are exact inverses', () => {
    const n = node({ status: 'active' })
    const include: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active'] }
    const exclude: GraphFilterRule = { ...include, mode: 'exclude' }
    expect(matchesRule(n, include, model())).toBe(true)
    expect(matchesRule(n, exclude, model())).toBe(false)
  })

  it('an empty-value exclude rule is inert (matches everything, excludes nothing)', () => {
    const n = node({ status: 'active' })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'status' }, mode: 'exclude', values: [] }
    expect(matchesRule(n, rule, model())).toBe(true)
  })

  it('numeric bounds are inclusive', () => {
    const n = node({ score: 5 })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'score' }, mode: 'include', min: 5, max: 10 }
    expect(matchesRule(n, rule, model())).toBe(true)
  })

  it('a value outside numeric bounds fails an include', () => {
    const n = node({ score: 11 })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'score' }, mode: 'include', min: 5, max: 10 }
    expect(matchesRule(n, rule, model())).toBe(false)
  })

  it('a missing value fails an include and passes an exclude', () => {
    const n = node({})
    const include: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active'] }
    const exclude: GraphFilterRule = { ...include, mode: 'exclude' }
    expect(matchesRule(n, include, model())).toBe(false)
    expect(matchesRule(n, exclude, model())).toBe(true)
  })
})

describe('list-valued fields', () => {
  // A tag/topic field is a YAML list, and "show only documents tagged Y" is
  // the spec's own example of an inclusionary filter. Matching the whole
  // array as one comma-joined string satisfies that for no real corpus.
  it('an include matches a document holding that value among others', () => {
    const n = node({ tags: ['topic/security', 'topic/azure'] })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'tags' }, mode: 'include', values: ['topic/security'] }
    expect(matchesRule(n, rule, model())).toBe(true)
  })

  it('an include does not match a document lacking the value', () => {
    const n = node({ tags: ['topic/azure'] })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'tags' }, mode: 'include', values: ['topic/security'] }
    expect(matchesRule(n, rule, model())).toBe(false)
  })

  it('an exclude hides a document holding the value among others', () => {
    const n = node({ tags: ['topic/security', 'topic/azure'] })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'tags' }, mode: 'exclude', values: ['topic/security'] }
    expect(matchesRule(n, rule, model())).toBe(false)
  })

  it('several rule values match a document carrying any one of them', () => {
    const n = node({ tags: ['topic/cost'] })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'tags' }, mode: 'include', values: ['topic/security', 'topic/cost'] }
    expect(matchesRule(n, rule, model())).toBe(true)
  })

  it('an empty list is missing, so it fails an include and passes an exclude', () => {
    const n = node({ tags: [] })
    const include: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'tags' }, mode: 'include', values: ['topic/security'] }
    expect(matchesRule(n, include, model())).toBe(false)
    expect(matchesRule(n, { ...include, mode: 'exclude' }, model())).toBe(true)
  })

  it('a scalar field still matches exactly, never as a substring', () => {
    const n = node({ type: 'com.dcim.orion.note' })
    const rule: GraphFilterRule = { dimension: { source: 'frontMatter', field: 'type' }, mode: 'include', values: ['com.dcim.orion'] }
    expect(matchesRule(n, rule, model())).toBe(false)
  })
})

describe('passesFilters', () => {
  it('rules AND together', () => {
    const n = node({ status: 'active', topic: 'ops' })
    const rules: GraphFilterRule[] = [
      { dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['active'] },
      { dimension: { source: 'frontMatter', field: 'topic' }, mode: 'include', values: ['infra'] },
    ]
    expect(passesFilters(n, rules, model())).toBe(false)
  })

  it('an empty rule set passes everything', () => {
    expect(passesFilters(node({}), [], model())).toBe(true)
  })
})

describe('prefix match', () => {
  it('a prefix rule hits when a member starts with a rule value, so a path subtree can be named', () => {
    const m = { nodes: [], edges: [], dangling: [], anchorSuppressions: [], discoveredFields: [], identityCollisions: [], centralityMethod: 'degree' as const }
    const node = { id: 'x', kind: 'document' as const, label: 'x', path: '/root/sections/staff/notes.md', frontMatter: { tags: ['topic/azure/networking'] }, sizeBytes: 0, modifiedMs: 0, degree: 0, community: 0, centrality: 0, orphan: false }
    const path = { source: 'mechanical' as const, property: 'path' as const }
    expect(matchesRule(node, { dimension: path, mode: 'include', values: ['/root/sections/'], match: 'prefix' }, m)).toBe(true)
    expect(matchesRule(node, { dimension: path, mode: 'include', values: ['/root/sections/'] }, m)).toBe(false)
    expect(matchesRule(node, { dimension: path, mode: 'exclude', values: ['/root/projects/'], match: 'prefix' }, m)).toBe(true)
    const tags = { source: 'frontMatter' as const, field: 'tags' }
    expect(matchesRule(node, { dimension: tags, mode: 'include', values: ['topic/azure'], match: 'prefix' }, m)).toBe(true)
  })
})
