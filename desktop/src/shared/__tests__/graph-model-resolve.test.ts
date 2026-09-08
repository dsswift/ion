/**
 * Tests for graph-model-resolve.ts (child 04): identity, label, group, and
 * section resolution. See specs/04-graph-model.tests.md TC-101..TC-105.
 */
import { describe, expect, it } from 'vitest'
import {
  buildDocumentNodes,
  buildGroupNodes,
  buildIndexes,
  buildSectionNodes,
  coerceScalar,
  dedupeDocuments,
  resolveIdentities,
  resolveLabel,
} from '../graph-model-resolve'
import { GRAPH_VIEW_DEFAULTS } from '../graph-view-types'
import type { GraphViewConfig } from '../graph-view-types'
import type { CorpusDocument } from '../graph-corpus-types'

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

describe('TC-101: identity resolution and path fallback', () => {
  it('a scalar id resolves', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } })], config())
    expect(idByPath.get('/root/a.md')).toBe('alpha')
  })
  it('no id falls back to the absolute path', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md' })], config())
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('id: 42 coerces to "42"', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: 42 } })], config())
    expect(idByPath.get('/root/a.md')).toBe('42')
  })
  it('id: true coerces to "true"', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: true } })], config())
    expect(idByPath.get('/root/a.md')).toBe('true')
  })
  it('id: "  " falls back to path', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: '   ' } })], config())
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('id: array falls back to path', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: ['a', 'b'] } })], config())
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('id: object falls back to path', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: { x: 1 } } })], config())
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('id: null falls back to path', () => {
    const { idByPath } = resolveIdentities([doc({ path: '/root/a.md', frontMatter: { id: null } })], config())
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('a node is always produced in every fallback case', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { id: null } })]
    const { idByPath } = resolveIdentities(documents, config())
    const nodes = buildDocumentNodes(documents, config(), idByPath)
    expect(nodes).toHaveLength(1)
  })
})

describe('TC-102: identity collisions never merge', () => {
  it('the first document keeps the identity, later ones fall back and are recorded', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } }),
      doc({ path: '/root/b.md', frontMatter: { id: 'alpha' } }),
    ]
    const { idByPath, collisions } = resolveIdentities(documents, config())
    expect(idByPath.get('/root/a.md')).toBe('alpha')
    expect(idByPath.get('/root/b.md')).toBe('/root/b.md')
    expect(collisions).toEqual([{ identity: 'alpha', winnerPath: '/root/a.md', loserPaths: ['/root/b.md'] }])
  })

  it('a third colliding document appends to the same entry', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } }),
      doc({ path: '/root/b.md', frontMatter: { id: 'alpha' } }),
      doc({ path: '/root/c.md', frontMatter: { id: 'alpha' } }),
    ]
    const { collisions } = resolveIdentities(documents, config())
    expect(collisions).toHaveLength(1)
    expect(collisions[0].loserPaths).toEqual(['/root/b.md', '/root/c.md'])
  })

  it('nothing is dropped: two document nodes still exist', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } }),
      doc({ path: '/root/b.md', frontMatter: { id: 'alpha' } }),
    ]
    const { idByPath } = resolveIdentities(documents, config())
    const nodes = buildDocumentNodes(documents, config(), idByPath)
    expect(nodes).toHaveLength(2)
  })
})

describe('TC-103: label resolution and filename fallback', () => {
  it('a title resolves as label', () => {
    expect(resolveLabel(doc({ path: '/root/a.md', frontMatter: { title: 'Alpha Doc' } }), config())).toBe('Alpha Doc')
  })
  it('no title falls back to fileName', () => {
    const d = doc({ path: '/root/a.md' })
    expect(resolveLabel(d, config())).toBe(d.fileName)
  })
  it('an empty title falls back to fileName', () => {
    const d = doc({ path: '/root/a.md', frontMatter: { title: '' } })
    expect(resolveLabel(d, config())).toBe(d.fileName)
  })
  it('a blank title falls back to fileName', () => {
    const d = doc({ path: '/root/a.md', frontMatter: { title: '  ' } })
    expect(resolveLabel(d, config())).toBe(d.fileName)
  })
  it('a list title falls back to fileName', () => {
    const d = doc({ path: '/root/a.md', frontMatter: { title: ['a'] } })
    expect(resolveLabel(d, config())).toBe(d.fileName)
  })
  it('a title with no id resolves label but identity falls back to path', () => {
    const d = doc({ path: '/root/a.md', frontMatter: { title: 'Alpha Doc' } })
    const { idByPath } = resolveIdentities([d], config())
    expect(resolveLabel(d, config())).toBe('Alpha Doc')
    expect(idByPath.get('/root/a.md')).toBe('/root/a.md')
  })
  it('an id with no title resolves identity but label falls back to filename', () => {
    const d = doc({ path: '/root/a.md', frontMatter: { id: 'alpha' } })
    const { idByPath } = resolveIdentities([d], config())
    expect(idByPath.get('/root/a.md')).toBe('alpha')
    expect(resolveLabel(d, config())).toBe(d.fileName)
  })
})

describe('TC-104: group nodes', () => {
  it('two documents sharing a topic produce one group node and two edges', () => {
    const documents = [
      doc({ path: '/root/a.md', frontMatter: { topic: 'ops' } }),
      doc({ path: '/root/b.md', frontMatter: { topic: 'ops' } }),
    ]
    const cfg = config({ groupFields: ['topic'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes, memberships } = buildGroupNodes(documents, cfg, idByPath)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ id: 'group:topic:ops', kind: 'group', label: 'ops' })
    expect(memberships).toHaveLength(2)
  })

  it('a list value produces multiple group nodes from one document', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { topic: ['ops', 'infra'] } })]
    const cfg = config({ groupFields: ['topic'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes, memberships } = buildGroupNodes(documents, cfg, idByPath)
    expect(nodes).toHaveLength(2)
    expect(memberships).toHaveLength(2)
  })

  it('two group fields produce distinct namespaced nodes', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { topic: 'ops', area: 'ops' } })]
    const cfg = config({ groupFields: ['topic', 'area'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes } = buildGroupNodes(documents, cfg, idByPath)
    const ids = nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['group:area:ops', 'group:topic:ops'])
  })

  it('groupFields: [] produces no group node', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { topic: 'ops' } })]
    const cfg = config({ groupFields: [] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes } = buildGroupNodes(documents, cfg, idByPath)
    expect(nodes).toEqual([])
  })

  it('a document missing the group field produces no edge and no error', () => {
    const documents = [doc({ path: '/root/a.md' })]
    const cfg = config({ groupFields: ['topic'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    expect(() => buildGroupNodes(documents, cfg, idByPath)).not.toThrow()
    const { memberships } = buildGroupNodes(documents, cfg, idByPath)
    expect(memberships).toEqual([])
  })
})

describe('TC-105: section nodes', () => {
  it('sectionNodes: false produces no section node even with sections present', () => {
    const documents = [doc({ path: '/root/a.md', sections: ['Intro'] })]
    const cfg = config({ sectionNodes: false })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes } = buildSectionNodes(documents, cfg, idByPath)
    expect(nodes).toEqual([])
  })

  it('sectionNodes: true produces one section node per heading with an edge', () => {
    const documents = [doc({ path: '/root/a.md', frontMatter: { id: 'alpha' }, sections: ['Intro'] })]
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes, memberships } = buildSectionNodes(documents, cfg, idByPath)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].id).toBe('alpha#Intro#1')
    expect(memberships).toEqual([{ docId: 'alpha', sectionId: 'alpha#Intro#1' }])
  })

  it('a repeated heading gets an ordinal, so two sections never share an identity', () => {
    // The corpus under test repeats one heading 66 times in a single file;
    // heading text alone collapsed every repetition into one node.
    const documents = [doc({ path: '/root/a.md', frontMatter: { id: 'alpha' }, sections: ['Notes', 'Notes', 'Other', 'Notes'] })]
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes, byHeading } = buildSectionNodes(documents, cfg, idByPath)
    expect(nodes.map((n) => n.id)).toEqual(['alpha#Notes#1', 'alpha#Notes#2', 'alpha#Other#1', 'alpha#Notes#3'])
    expect(new Set(nodes.map((n) => n.id)).size).toBe(4)
    // A link names a heading, never an ordinal: it resolves to the first.
    expect(byHeading.get('alpha')?.get('Notes')).toBe('alpha#Notes#1')
  })

  it('a section carries only the topics its declaration gives it, and takes them over from the document', () => {
    const documents = [
      doc({
        path: '/root/journal.md',
        frontMatter: {
          id: 'day',
          tags: ['topic/kubernetes', 'topic/hiring', 'topic/budget'],
          sections: [
            { heading: 'Cluster upgrade', tags: ['topic/kubernetes'] },
            { heading: 'Interviews', ordinal: 2, tags: ['topic/hiring'] },
            { heading: 'Missing heading', tags: ['topic/ghost'] },
          ],
        },
        sections: ['Cluster upgrade', 'Interviews', 'Interviews'],
      }),
    ]
    const cfg = config({ sectionNodes: true, groupFields: ['tags'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const sections = buildSectionNodes(documents, cfg, idByPath)
    expect(sections.nodes.find((n) => n.id === 'day#Cluster upgrade#1')?.frontMatter).toEqual({ tags: ['topic/kubernetes'] })
    expect(sections.nodes.find((n) => n.id === 'day#Interviews#1')?.frontMatter).toEqual({})
    expect(sections.nodes.find((n) => n.id === 'day#Interviews#2')?.frontMatter).toEqual({ tags: ['topic/hiring'] })
    expect(sections.unmatchedDeclarations).toBe(1)

    const groups = buildGroupNodes(documents, cfg, idByPath, sections)
    const edges = groups.memberships.map((m) => `${m.docId} -> ${m.groupId}`).sort()
    // The container keeps only the subject none of its sections claimed;
    // kubernetes and hiring hang off their sections and are never
    // neighbours through the day that happened to hold both.
    expect(edges).toEqual([
      'day -> group:tags:topic/budget',
      'day#Cluster upgrade#1 -> group:tags:topic/kubernetes',
      'day#Interviews#2 -> group:tags:topic/hiring',
    ])
    expect(groups.movedToSections).toBe(2)
  })

  it('with section nodes off, a document keeps every topic it declares', () => {
    const documents = [doc({ path: '/root/journal.md', frontMatter: { id: 'day', tags: ['a', 'b'], sections: [{ heading: 'X', tags: ['a'] }] }, sections: ['X'] })]
    const cfg = config({ sectionNodes: false, groupFields: ['tags'] })
    const { idByPath } = resolveIdentities(documents, cfg)
    const groups = buildGroupNodes(documents, cfg, idByPath, buildSectionNodes(documents, cfg, idByPath))
    expect(groups.memberships.map((m) => m.groupId).sort()).toEqual(['group:tags:a', 'group:tags:b'])
    expect(groups.movedToSections).toBe(0)
  })

  it('a section node is never an orphan', () => {
    const documents = [doc({ path: '/root/a.md', sections: ['Intro'] })]
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(documents, cfg)
    const { nodes } = buildSectionNodes(documents, cfg, idByPath)
    expect(nodes[0].orphan).toBe(false)
  })
})

describe('coerceScalar / dedupeDocuments / buildIndexes', () => {
  it('coerceScalar handles the primitive matrix', () => {
    expect(coerceScalar('a')).toBe('a')
    expect(coerceScalar('  ')).toBeNull()
    expect(coerceScalar(42)).toBe('42')
    expect(coerceScalar(true)).toBe('true')
    expect(coerceScalar([1, 2])).toBeNull()
    expect(coerceScalar({ a: 1 })).toBeNull()
    expect(coerceScalar(null)).toBeNull()
    expect(coerceScalar(undefined)).toBeNull()
  })

  it('dedupeDocuments keeps the longest rootPath for a duplicated path', () => {
    const documents = [
      doc({ path: '/root/sub/a.md', rootPath: '/root' }),
      doc({ path: '/root/sub/a.md', rootPath: '/root/sub' }),
    ]
    const deduped = dedupeDocuments(documents)
    expect(deduped).toHaveLength(1)
    expect(deduped[0].rootPath).toBe('/root/sub')
  })

  it('buildIndexes marks a filename claimed by two documents as ambiguous', () => {
    const documents = [doc({ path: '/root/a/notes.md' }), doc({ path: '/root/b/notes.md' })]
    const cfg = config()
    const { idByPath } = resolveIdentities(documents, cfg)
    const { byFileName } = buildIndexes(documents, idByPath)
    expect(typeof byFileName.get('notes')).toBe('symbol')
  })
})

describe('section decomposition is restricted to the documents in view', () => {
  /**
   * Regression: decomposing a whole corpus multiplies it by its heading
   * count. A real 2,192-document corpus became 39,200 nodes, which stutters
   * under the simulation and cannot be read once it settles.
   */
  const docs = [
    doc({ path: '/root/a.md', frontMatter: { id: 'alpha' }, sections: ['One', 'Two'] }),
    doc({ path: '/root/b.md', frontMatter: { id: 'beta' }, sections: ['Three'] }),
  ]

  it('decomposes only the named documents', () => {
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(docs, cfg)
    const result = buildSectionNodes(docs, cfg, idByPath, new Set(['alpha']))
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes.every((n) => n.id.startsWith('alpha#'))).toBe(true)
  })

  it('an empty restriction yields no sections at all', () => {
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(docs, cfg)
    expect(buildSectionNodes(docs, cfg, idByPath, new Set()).nodes).toHaveLength(0)
  })

  it('no restriction decomposes every document, for a caller with no scope of its own', () => {
    const cfg = config({ sectionNodes: true })
    const { idByPath } = resolveIdentities(docs, cfg)
    expect(buildSectionNodes(docs, cfg, idByPath, null).nodes).toHaveLength(3)
  })

  it('the toggle still governs: a restriction never turns sections on', () => {
    const cfg = config({ sectionNodes: false })
    const { idByPath } = resolveIdentities(docs, cfg)
    expect(buildSectionNodes(docs, cfg, idByPath, new Set(['alpha'])).nodes).toHaveLength(0)
  })
})
