/**
 * The graph command contract is validated on both sides of the IPC seam, so
 * these tests pin what a legal command and a legal reply are.
 */
import { describe, expect, it } from 'vitest'
import { parseChannelDimension, parseGraphCommand, parseGraphCommandEnvelope, parseGraphCommandResult, parseGraphFilterRule, parseGraphFilterRules } from './studio-graph-types'

const base = { conversationId: 'tab-1', cwd: '/proj' }

describe('parseGraphCommand', () => {
  it('refuses a command with no owner or directory', () => {
    expect(parseGraphCommand({ kind: 'state', cwd: '/proj' })).toBeNull()
    expect(parseGraphCommand({ kind: 'state', conversationId: 'tab-1' })).toBeNull()
    expect(parseGraphCommand({ kind: 'nope', ...base })).toBeNull()
  })

  it('accepts the argument-free verbs', () => {
    for (const kind of ['open', 'state', 'clear-highlight', 'fit'] as const) {
      expect(parseGraphCommand({ kind, ...base })).toEqual({ kind, ...base })
    }
  })

  it('bounds search limits and defaults them', () => {
    expect(parseGraphCommand({ kind: 'search', ...base, query: 'plan' })).toEqual({ kind: 'search', ...base, query: 'plan', limit: 20 })
    expect(parseGraphCommand({ kind: 'search', ...base, query: 'plan', limit: 500 })).toMatchObject({ limit: 20 })
    expect(parseGraphCommand({ kind: 'search', ...base, query: '' })).toBeNull()
  })

  it('requires at least one highlight id and defaults the camera to fit', () => {
    expect(parseGraphCommand({ kind: 'highlight', ...base, nodeIds: [] })).toBeNull()
    expect(parseGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a', 'b'] })).toEqual({ kind: 'highlight', ...base, nodeIds: ['a', 'b'], camera: 'fit' })
    expect(parseGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a'], camera: 'none' })).toMatchObject({ camera: 'none' })
    expect(parseGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a', 7] })).toBeNull()
  })

  it('validates scope arguments', () => {
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'corpus' })).toEqual({ kind: 'scope', ...base, mode: 'corpus' })
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood' })).toBeNull()
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', depth: 2 })).toEqual({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', depth: 2 })
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', depth: 0 })).toBeNull()
  })

  it('treats a missing peek id as close', () => {
    expect(parseGraphCommand({ kind: 'peek', ...base })).toEqual({ kind: 'peek', ...base, nodeId: null })
    expect(parseGraphCommand({ kind: 'peek', ...base, nodeId: 'a' })).toEqual({ kind: 'peek', ...base, nodeId: 'a' })
  })

  it('wraps a command in an envelope only with a correlator', () => {
    expect(parseGraphCommandEnvelope({ callId: 'c1', command: { kind: 'state', ...base } })).toEqual({ callId: 'c1', command: { kind: 'state', ...base } })
    expect(parseGraphCommandEnvelope({ command: { kind: 'state', ...base } })).toBeNull()
  })
})

describe('filter rules', () => {
  it('accepts every dimension shape and nothing else', () => {
    expect(parseChannelDimension({ source: 'frontMatter', field: 'status' })).toEqual({ source: 'frontMatter', field: 'status' })
    expect(parseChannelDimension({ source: 'structural', metric: 'degree' })).toEqual({ source: 'structural', metric: 'degree' })
    expect(parseChannelDimension({ source: 'mechanical', property: 'path' })).toEqual({ source: 'mechanical', property: 'path' })
    expect(parseChannelDimension({ source: 'edge', metric: 'recency' })).toEqual({ source: 'edge', metric: 'recency' })
    expect(parseChannelDimension({ source: 'structural', metric: 'colour' })).toBeNull()
    expect(parseChannelDimension({ source: 'frontMatter' })).toBeNull()
  })

  it('rejects a list with one bad rule rather than dropping it', () => {
    const good = { dimension: { source: 'frontMatter', field: 'status' }, mode: 'include', values: ['draft'] }
    expect(parseGraphFilterRules([good])).toEqual([good])
    expect(parseGraphFilterRules([good, { dimension: { source: 'frontMatter', field: 'x' }, mode: 'sometimes' }])).toBeNull()
    expect(parseGraphFilterRules([{ dimension: { source: 'structural', metric: 'degree' }, mode: 'include', min: 'two' }])).toBeNull()
    expect(parseGraphFilterRules([{ dimension: { source: 'structural', metric: 'degree' }, mode: 'include', min: 2, max: 9 }])).toEqual([
      { dimension: { source: 'structural', metric: 'degree' }, mode: 'include', min: 2, max: 9 },
    ])
  })
})

describe('parseGraphCommandResult', () => {
  it('keeps the correlator, verdict, and payload', () => {
    const parsed = parseGraphCommandResult({
      callId: 'c1',
      ok: true,
      note: 'layout still running',
      state: {
        projectPath: '/proj', nodeCount: 2, edgeCount: 1, visibleCount: 2, layoutState: 'running',
        selectedNodeIds: ['a'], highlightedNodeIds: ['b'], scope: { mode: 'neighborhood', anchorId: 'a', depth: 2 },
        filters: [], bindings: { nodeColor: { source: 'structural', metric: 'community' }, nodeSize: { source: 'bogus' } },
        savedViews: ['Overview'], discoveredFields: ['status'], cameraRatio: 0.5,
      },
      nodes: [{ id: 'a', label: 'A', kind: 'document', path: '/proj/a.md', degree: 1, community: 0, centrality: 0.5, orphan: false, visible: true }, { label: 'no id' }],
      neighbors: [{ id: 'b', label: 'B', direction: 'in', origin: 'wikilink' }],
    })
    expect(parsed).toMatchObject({ callId: 'c1', ok: true, note: 'layout still running' })
    expect(parsed?.state?.scope).toEqual({ mode: 'neighborhood', anchorId: 'a', depth: 2, direction: 'both' })
    // An unparseable binding is dropped rather than failing the whole reply.
    expect(parsed?.state?.bindings).toEqual({ nodeColor: { source: 'structural', metric: 'community' } })
    expect(parsed?.nodes).toHaveLength(1)
    expect(parsed?.neighbors).toEqual([{ id: 'b', label: 'B', direction: 'in', origin: 'wikilink' }])
  })

  it('refuses a reply without a verdict', () => {
    expect(parseGraphCommandResult({ callId: 'c1' })).toBeNull()
    expect(parseGraphCommandResult({ ok: true })).toBeNull()
  })
})

describe('scope direction, filter match, and edge-kind dimensions', () => {
  const base = { conversationId: 'c1', cwd: '/proj' }
  it('accepts a scope direction and rejects an unknown one', () => {
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', direction: 'in' })).toEqual({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', direction: 'in' })
    expect(parseGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'a', direction: 'sideways' })).toBeNull()
  })
  it('accepts a prefix match on a rule and the origin and field edge dimensions', () => {
    const rule = { dimension: { source: 'mechanical', property: 'path' }, mode: 'include', values: ['/a/'], match: 'prefix' }
    expect(parseGraphFilterRule(rule)).toEqual(rule)
    expect(parseGraphFilterRule({ ...rule, match: 'fuzzy' })).toBeNull()
    expect(parseChannelDimension({ source: 'edge', metric: 'origin' })).toEqual({ source: 'edge', metric: 'origin' })
    expect(parseChannelDimension({ source: 'edge', metric: 'field' })).toEqual({ source: 'edge', metric: 'field' })
  })
})
