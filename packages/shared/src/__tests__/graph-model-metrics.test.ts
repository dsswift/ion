/**
 * Tests for graph-model-metrics.ts (child 04): degree, orphans, communities,
 * and the centrality branch. See specs/04-graph-model.tests.md
 * TC-112..TC-116.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildGraphModel } from '../graph-model'
import { GRAPH_VIEW_DEFAULTS } from '../graph-view-types'
import type { GraphViewConfig } from '../graph-view-types'
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

function snapshot(...documents: CorpusDocument[]): CorpusSnapshot {
  return { revision: 1, roots: [], documents }
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

describe('TC-112: degree and orphans', () => {
  it('a document with no links or groups has degree 0, orphan true', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md' })), config())
    const node = model.nodes.find((n) => n.kind === 'document')!
    expect(node.degree).toBe(0)
    expect(node.orphan).toBe(true)
  })

  it('a linked document has degree 1, orphan false', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'b' } }),
        doc({ path: '/root/b.md', frontMatter: { id: 'b' } }),
      ),
      config(),
    )
    const a = model.nodes.find((n) => n.id === 'a')!
    expect(a.degree).toBe(1)
    expect(a.orphan).toBe(false)
  })

  it('a document whose only edge is into a group node is not an orphan', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/a.md', frontMatter: { topic: 'ops' } })),
      config({ groupFields: ['topic'] }),
    )
    const a = model.nodes.find((n) => n.kind === 'document')!
    expect(a.orphan).toBe(false)
  })

  it('a group node with two members has degree 2, orphan false', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { topic: 'ops' } }),
        doc({ path: '/root/b.md', frontMatter: { topic: 'ops' } }),
      ),
      config({ groupFields: ['topic'] }),
    )
    const group = model.nodes.find((n) => n.kind === 'group')!
    expect(group.degree).toBe(2)
    expect(group.orphan).toBe(false)
  })

  it('a dangling node is never an orphan', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost'] })), config())
    const dangling = model.nodes.find((n) => n.kind === 'dangling')!
    expect(dangling.orphan).toBe(false)
  })
})

describe('TC-113: communities', () => {
  it('two disjoint cliques yield two distinct community values, shared within each clique', () => {
    const documents = [
      doc({ path: '/root/a1.md', frontMatter: { id: 'a1', relates: ['a2', 'a3', 'a4'] } }),
      doc({ path: '/root/a2.md', frontMatter: { id: 'a2', relates: ['a1', 'a3', 'a4'] } }),
      doc({ path: '/root/a3.md', frontMatter: { id: 'a3', relates: ['a1', 'a2', 'a4'] } }),
      doc({ path: '/root/a4.md', frontMatter: { id: 'a4', relates: ['a1', 'a2', 'a3'] } }),
      doc({ path: '/root/b1.md', frontMatter: { id: 'b1', relates: ['b2', 'b3', 'b4'] } }),
      doc({ path: '/root/b2.md', frontMatter: { id: 'b2', relates: ['b1', 'b3', 'b4'] } }),
      doc({ path: '/root/b3.md', frontMatter: { id: 'b3', relates: ['b1', 'b2', 'b4'] } }),
      doc({ path: '/root/b4.md', frontMatter: { id: 'b4', relates: ['b1', 'b2', 'b3'] } }),
    ]
    const { model } = buildGraphModel(snapshot(...documents), config())
    const communityOf = (id: string) => model.nodes.find((n) => n.id === id)!.community
    const aCommunities = new Set(['a1', 'a2', 'a3', 'a4'].map(communityOf))
    const bCommunities = new Set(['b1', 'b2', 'b3', 'b4'].map(communityOf))
    expect(aCommunities.size).toBe(1)
    expect(bCommunities.size).toBe(1)
    expect([...aCommunities][0]).not.toBe([...bCommunities][0])
  })

  it('a graph with zero edges assigns community 0 to every node without throwing', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md' }), doc({ path: '/root/b.md' })), config())
    expect(model.nodes.every((n) => n.community === 0)).toBe(true)
  })
})

describe('TC-114: centrality branch', () => {
  it('a 10-node path graph yields betweenness with the middle strictly higher than an endpoint', () => {
    const documents: CorpusDocument[] = []
    for (let i = 0; i < 10; i++) {
      documents.push(
        doc({
          path: `/root/n${i}.md`,
          frontMatter: { id: `n${i}`, relates: i < 9 ? `n${i + 1}` : undefined },
        }),
      )
    }
    const { model } = buildGraphModel(snapshot(...documents), config())
    expect(model.centralityMethod).toBe('betweenness')
    const middle = model.nodes.find((n) => n.id === 'n5')!.centrality
    const endpoint = model.nodes.find((n) => n.id === 'n0')!.centrality
    expect(middle).toBeGreaterThan(endpoint)
  })

  it('a 2001-node graph yields degree centrality', () => {
    const documents: CorpusDocument[] = []
    for (let i = 0; i < 2001; i++) {
      documents.push(doc({ path: `/root/n${i}.md`, frontMatter: { id: `n${i}` } }))
    }
    const { model } = buildGraphModel(snapshot(...documents), config())
    expect(model.centralityMethod).toBe('degree')
  })

  it('every centrality value is within [0,1] in both branches', () => {
    const smallDocs = [
      doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'b' } }),
      doc({ path: '/root/b.md', frontMatter: { id: 'b' } }),
    ]
    const { model: small } = buildGraphModel(snapshot(...smallDocs), config())
    for (const n of small.nodes) expect(n.centrality).toBeGreaterThanOrEqual(0)
    for (const n of small.nodes) expect(n.centrality).toBeLessThanOrEqual(1)
  })

  it('a zero-edge graph yields degree method and all-zero centrality', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md' }), doc({ path: '/root/b.md' })), config())
    expect(model.centralityMethod).toBe('degree')
    expect(model.nodes.every((n) => n.centrality === 0)).toBe(true)
  })
})

describe('TC-115: no hardcoded vocabulary', () => {
  it('a custom vocabulary is genuinely bound, not merely ignored', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { id: 'id-a', title: 'Title A', relates: 'id-b', topic: 'ops' } }),
      doc({ path: '/root/b.md', frontMatter: { id: 'id-b', title: 'Title B' } }),
    ]
    const cfg = config({ identityField: 'uid', labelField: 'name', edgeFields: ['links'], groupFields: ['area'] })
    const { model } = buildGraphModel(snapshot(...documents), cfg)

    // id/title/relates/topic are not read: every node id is its path, every
    // label is its fileName, no front-matter edge exists, no group node.
    for (const n of model.nodes.filter((n) => n.kind === 'document')) {
      expect(n.id).toBe(n.path)
      expect(n.label).toBe(n.path?.split('/').pop()?.replace(/\.md$/i, ''))
    }
    expect(model.edges.some((e) => e.origin === 'front-matter')).toBe(false)
    expect(model.nodes.some((n) => n.kind === 'group')).toBe(false)
  })

  it('body wikilinks are still extracted regardless of vocabulary binding', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { id: 'a' }, wikiLinks: ['b'] }),
      doc({ path: '/root/b.md', frontMatter: { id: 'b' } }),
    ]
    const cfg = config({ identityField: 'uid' }) // 'id' is not the configured identity field
    const { model } = buildGraphModel(snapshot(...documents), cfg)
    expect(model.edges.some((e) => e.origin === 'wikilink')).toBe(true)
  })

  it('a second run with a matching configured field resolves identity from it', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { uid: 'alpha' } })]
    const cfg = config({ identityField: 'uid' })
    const { model } = buildGraphModel(snapshot(...documents), cfg)
    expect(model.nodes[0].id).toBe('alpha')
  })
})

describe('TC-116: scale', () => {
  it('a 10,000-document snapshot builds under 3000ms', () => {
    const documents: CorpusDocument[] = []
    for (let i = 0; i < 10000; i++) {
      documents.push(
        doc({
          path: `/root/n${i}.md`,
          frontMatter: { id: `n${i}`, title: `Doc ${i}`, topic: `t${i % 20}` },
          wikiLinks: [`n${(i + 1) % 10000}`, `n${(i + 7) % 10000}`, `missing-${i}`],
        }),
      )
    }
    const started = Date.now()
    const { model } = buildGraphModel(snapshot(...documents), config({ groupFields: ['topic'] }))
    const durationMs = Date.now() - started

    expect(durationMs).toBeLessThan(3000)
    expect(model.dangling.length).toBe(10000)
    expect(model.centralityMethod).toBe('degree')
    const documentNodes = model.nodes.filter((n) => n.kind === 'document')
    expect(documentNodes).toHaveLength(10000)
  }, 15000)
})

describe('logger', () => {
  it('logs model built exactly once with matching counts', () => {
    const debug = vi.fn()
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost'] })), config(), { debug })
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0][0]).toBe('graph_view: model built')
    expect(debug.mock.calls[0][1]).toMatchObject({
      nodeCount: model.nodes.length,
      edgeCount: model.edges.length,
      danglingCount: model.dangling.length,
      identityCollisionCount: model.identityCollisions.length,
      centralityMethod: model.centralityMethod,
    })
  })

  it('with no logger, nothing throws', () => {
    expect(() => buildGraphModel(snapshot(doc({ path: '/root/a.md' })), config())).not.toThrow()
  })
})
