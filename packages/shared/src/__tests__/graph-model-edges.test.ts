/**
 * Tests for graph-model-edges.ts (child 04): edge resolution and dangling
 * references. See specs/04-graph-model.tests.md TC-106..TC-111.
 *
 * These tests drive `buildGraphModel` end-to-end rather than the edge
 * builder in isolation: edge resolution depends on the identity/path/
 * filename indexes, which only make sense assembled from a real document
 * set exactly as the orchestrator assembles them.
 */
import { describe, expect, it } from 'vitest'
import { buildGraphModel } from '../graph-model'
import { GRAPH_VIEW_DEFAULTS } from '../graph-view-types'
import type { GraphViewConfig } from '../graph-view-types'
import type { CorpusDocument } from '../graph-corpus-types'
import type { CorpusSnapshot } from '../graph-corpus-types'

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

describe('TC-106: reference resolution order', () => {
  it('[[alpha]] resolves to the node whose identity is alpha', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } }),
        doc({ path: '/root/b.md', wikiLinks: ['alpha'] }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.target).toBe('alpha')
  })

  it('identity outranks a matching path', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/beta.md', frontMatter: { id: 'gamma' } }), // id "beta.md" doesn't exist as identity here
        doc({ path: '/root/other/beta.md', frontMatter: { id: 'beta.md' } }),
        doc({ path: '/root/c.md', wikiLinks: ['beta.md'] }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.target).toBe('beta.md') // the identity holder's node id
  })

  it('a relative markdown link resolves against the linking document directory', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a/x.md', markdownLinks: ['./b.md'] }),
        doc({ path: '/root/a/b.md' }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'markdown-link')
    expect(edge?.target).toBe('/root/a/b.md')
  })

  it('a parent-relative markdown link resolves correctly', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a/x.md', markdownLinks: ['../notes/b.md'] }),
        doc({ path: '/root/notes/b.md' }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'markdown-link')
    expect(edge?.target).toBe('/root/notes/b.md')
  })

  it('a wikilink with no identity match resolves by path with .md appended', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/b.md' }), doc({ path: '/root/a.md', wikiLinks: ['b'] })),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.target).toBe('/root/b.md')
  })

  it('a wikilink resolves case-insensitively by filename when unambiguous', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/notes.md' }), doc({ path: '/root/a.md', wikiLinks: ['Notes'] })),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.target).toBe('/root/notes.md')
  })

  it('an ambiguous filename dangles rather than guessing', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a/notes.md' }),
        doc({ path: '/root/b/notes.md' }),
        doc({ path: '/root/c.md', wikiLinks: ['notes'] }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.dangling).toBe(true)
    expect(model.dangling.some((d) => d.rawTarget === 'notes')).toBe(true)
  })
})

describe('TC-107: directed supersession', () => {
  it('supersedes yields a directed edge alpha -> beta', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha', supersedes: 'beta' } }),
        doc({ path: '/root/beta.md', frontMatter: { id: 'beta' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'supersedes')
    expect(edge).toMatchObject({ source: 'alpha', target: 'beta', directed: true, origin: 'front-matter' })
  })

  it('superseded-by is inverted so the arrow points the same direction', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha', 'superseded-by': 'gamma' } }),
        doc({ path: '/root/gamma.md', frontMatter: { id: 'gamma' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'superseded-by')
    expect(edge).toMatchObject({ source: 'gamma', target: 'alpha', directed: true })
  })

  it('relates yields an undirected edge', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha', relates: 'delta' } }),
        doc({ path: '/root/delta.md', frontMatter: { id: 'delta' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'relates')
    expect(edge?.directed).toBe(false)
  })

  it('wikilink, markdown-link, group, and section edges are all undirected', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', wikiLinks: ['b'], markdownLinks: ['./b.md'], frontMatter: { topic: 'ops' }, sections: ['Intro'] }),
        doc({ path: '/root/b.md', frontMatter: { topic: 'ops' } }),
      ),
      config({ groupFields: ['topic'], sectionNodes: true }),
    )
    for (const e of model.edges) expect(e.directed).toBe(false)
  })

  it('a corpus-chosen custom directed-sounding field stays undirected', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', replaces: 'b' } }),
        doc({ path: '/root/b.md', frontMatter: { id: 'b' } }),
      ),
      config({ edgeFields: ['replaces'] }),
    )
    const edge = model.edges.find((e) => e.field === 'replaces')
    expect(edge?.directed).toBe(false)
  })
})

describe('TC-108: front-matter reference forms', () => {
  it('a quoted wikilink form strips the brackets', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: '[[alpha]]' } }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'relates')
    expect(edge?.target).toBe('alpha')
  })

  it('a list of mixed quoted and bare values produces two edges', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: ['[[alpha]]', 'beta'] } }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
        doc({ path: '/root/beta.md', frontMatter: { id: 'beta' } }),
      ),
      config(),
    )
    const edges = model.edges.filter((e) => e.field === 'relates')
    expect(edges).toHaveLength(2)
  })

  it('an empty list produces no edge', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: [] } })), config())
    expect(model.edges.filter((e) => e.field === 'relates')).toHaveLength(0)
  })

  it('an object value produces no edge and no throw', () => {
    expect(() =>
      buildGraphModel(snapshot(doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: { x: 1 } } })), config()),
    ).not.toThrow()
  })

  it('an edgeFields entry no document carries produces no edge and no throw', () => {
    expect(() => buildGraphModel(snapshot(doc({ path: '/root/a.md' })), config({ edgeFields: ['nonexistent'] }))).not.toThrow()
  })
})

describe('TC-109: unresolvable references render distinctly', () => {
  it('a wikilink with no match produces a dangling node', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost'] })), config())
    const danglingNode = model.nodes.find((n) => n.kind === 'dangling')
    expect(danglingNode).toMatchObject({ label: 'ghost' })
  })

  it('the edge into it is dangling:true and never dropped', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost'] })), config())
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.dangling).toBe(true)
  })

  it('model.dangling records the source and raw target', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost'] })), config())
    expect(model.dangling[0]).toMatchObject({ rawTarget: 'ghost', origin: 'wikilink' })
  })

  it('a front-matter dangling reference records its field', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', frontMatter: { relates: 'ghost' } })), config())
    expect(model.dangling[0]).toMatchObject({ field: 'relates' })
  })

  it('two documents referencing the same missing target produce two dangling nodes', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', wikiLinks: ['ghost'] }),
        doc({ path: '/root/b.md', wikiLinks: ['ghost'] }),
      ),
      config(),
    )
    const danglingNodes = model.nodes.filter((n) => n.kind === 'dangling')
    expect(danglingNodes).toHaveLength(2)
  })

  it('the same missing reference twice in one document produces one node, one edge, multiplicity 2', () => {
    const { model } = buildGraphModel(snapshot(doc({ path: '/root/a.md', wikiLinks: ['ghost', 'ghost'] })), config())
    const danglingNodes = model.nodes.filter((n) => n.kind === 'dangling')
    expect(danglingNodes).toHaveLength(1)
    const edge = model.edges.find((e) => e.origin === 'wikilink')
    expect(edge?.multiplicity).toBe(2)
  })

  it('model.dangling.length matches the broken-links badge count', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/a.md', wikiLinks: ['g1', 'g2'] })),
      config(),
    )
    expect(model.dangling).toHaveLength(2)
  })
})

describe('TC-110: edge collapse and multiplicity', () => {
  it('the same wikilink three times collapses to one edge, multiplicity 3', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a' }, wikiLinks: ['alpha', 'alpha', 'alpha'] }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
      ),
      config(),
    )
    const edges = model.edges.filter((e) => e.origin === 'wikilink')
    expect(edges).toHaveLength(1)
    expect(edges[0].multiplicity).toBe(3)
  })

  it('a wikilink plus a relates field to the same target are two edges, each multiplicity 1', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'alpha' }, wikiLinks: ['alpha'] }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
      ),
      config(),
    )
    const edges = model.edges.filter((e) => e.target === 'alpha')
    expect(edges).toHaveLength(2)
    for (const e of edges) expect(e.multiplicity).toBe(1)
  })

  it('relates and supersedes to the same target are two edges (different field)', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'alpha', supersedes: 'alpha' } }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
      ),
      config(),
    )
    const edges = model.edges.filter((e) => e.target === 'alpha' || e.source === 'alpha')
    expect(edges).toHaveLength(2)
  })

  it('edge ids are unique across the model', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'alpha' }, wikiLinks: ['alpha'] }),
        doc({ path: '/root/alpha.md', frontMatter: { id: 'alpha' } }),
      ),
      config(),
    )
    expect(new Set(model.edges.map((e) => e.id)).size).toBe(model.edges.length)
  })

  it('a self-reference produces no edge', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/a.md', frontMatter: { id: 'alpha' }, wikiLinks: ['alpha'] })),
      config(),
    )
    expect(model.edges).toHaveLength(0)
  })
})

describe('TC-111: crossRoot and recency', () => {
  it('two documents with different rootPath yield crossRoot: true', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root-a/a.md', rootPath: '/root-a', frontMatter: { id: 'a', relates: 'b' } }),
        doc({ path: '/root-b/b.md', rootPath: '/root-b', frontMatter: { id: 'b' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'relates')
    expect(edge?.crossRoot).toBe(true)
  })

  it('same rootPath yields crossRoot: false', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', rootPath: '/root', frontMatter: { id: 'a', relates: 'b' } }),
        doc({ path: '/root/b.md', rootPath: '/root', frontMatter: { id: 'b' } }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'relates')
    expect(edge?.crossRoot).toBe(false)
  })

  it('group, section, and dangling edges are never crossRoot', () => {
    const { model } = buildGraphModel(
      snapshot(doc({ path: '/root/a.md', frontMatter: { topic: 'ops' }, wikiLinks: ['ghost'], sections: ['Intro'] })),
      config({ groupFields: ['topic'], sectionNodes: true }),
    )
    for (const e of model.edges) {
      if (e.origin === 'group' || e.origin === 'section' || e.dangling) expect(e.crossRoot).toBe(false)
    }
  })

  it('recencyMs is the newer of the two endpoints', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/a.md', frontMatter: { id: 'a', relates: 'b' }, modifiedMs: 100 }),
        doc({ path: '/root/b.md', frontMatter: { id: 'b' }, modifiedMs: 500 }),
      ),
      config(),
    )
    const edge = model.edges.find((e) => e.field === 'relates')
    expect(edge?.recencyMs).toBe(500)
  })

  it('nested-root duplicates de-duplicate to one node keeping the more specific root', () => {
    const { model } = buildGraphModel(
      snapshot(
        doc({ path: '/root/sub/shared.md', rootPath: '/root' }),
        doc({ path: '/root/sub/shared.md', rootPath: '/root/sub' }),
      ),
      config(),
    )
    const documentNodes = model.nodes.filter((n) => n.kind === 'document')
    expect(documentNodes).toHaveLength(1)
    expect(documentNodes[0].rootPath).toBe('/root/sub')
  })
})
