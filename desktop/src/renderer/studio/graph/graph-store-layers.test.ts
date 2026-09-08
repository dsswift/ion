// @vitest-environment jsdom
/**
 * The view-time layers and local-graph controls: collapse undoes exactly
 * one expansion, depth steps both ways, direction is honoured, per-node
 * hides and the dangling toggle are visibility facts, a structural toggle
 * rebuilds the model and asks for a run confined to what it added, and a
 * saved view never carries a provisional identity.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { SECTION_NODE_BUDGET } from './graph-store-corpus'
import { clearAllSessions } from './session-park'
import { GRAPH_VIEW_DEFAULTS, LAYOUT_FORCES_COMPACT } from '../../../shared/graph-view-types'
import type { GraphViewConfig } from '../../../shared/graph-view-types'
import type { CorpusDocument, CorpusSnapshot } from '../../../shared/graph-corpus-types'

function config(): GraphViewConfig {
  return {
    corpusRoots: [{ path: '/root' }],
    identityField: GRAPH_VIEW_DEFAULTS.identityField,
    labelField: GRAPH_VIEW_DEFAULTS.labelField,
    tagField: GRAPH_VIEW_DEFAULTS.tagField,
    groupFields: GRAPH_VIEW_DEFAULTS.groupFields,
    edgeFields: GRAPH_VIEW_DEFAULTS.edgeFields,
    hoverFields: GRAPH_VIEW_DEFAULTS.hoverFields,
    curatedFields: [],
    promotedFields: [{ field: 'owner' }],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: false,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: 1,
  }
}

function doc(id: string, links: string[] = [], extra: Partial<CorpusDocument> = {}): CorpusDocument {
  return { path: `/root/${id}.md`, rootPath: '/root', fileName: id, frontMatter: { id, owner: id < 'c' ? 'team/x' : 'team/y' }, wikiLinks: links, markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1, ...extra }
}

/** a -> b -> c -> d, e isolated, u unstamped (path-keyed) linking to a ghost. */
function snapshot(): CorpusSnapshot {
  return {
    revision: 1,
    roots: [{ path: '/root', exists: true, documentCount: 6 }],
    documents: [
      doc('a', ['b']),
      doc('b', ['c']),
      doc('c', ['d']),
      doc('d', [], { sections: ['Intro', 'Intro'] }),
      doc('e'),
      { path: '/root/u.md', rootPath: '/root', fileName: 'u', frontMatter: {}, wikiLinks: ['ghost'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
    ],
  }
}

let setUserConfig: ReturnType<typeof vi.fn>

beforeEach(async () => {
  setUserConfig = vi.fn(async () => ({ ok: true }))
  window.ion = {
    graphViewGetConfig: vi.fn(async () => config()),
    graphViewSetUserConfig: setUserConfig,
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot()),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
  await useGraphStore.getState().init('/root')
  useGraphStore.getState().setLayoutState('settled')
})

afterEach(() => {
  useGraphStore.getState().dispose()
  clearAllSessions()
  vi.restoreAllMocks()
})

const visible = (): string[] => [...useGraphStore.getState().visibleNodeIds].sort()

describe('collapse', () => {
  it('collapseNodeScope removes what only that expansion added and keeps the rest', () => {
    const s = useGraphStore.getState()
    s.setScopeToNeighborhood('a', 1)
    s.expandNodeScope('c')
    s.expandNodeScope('d')
    expect(visible()).toEqual(['a', 'b', 'c', 'd'])
    s.collapseNodeScope('d')
    // c's expansion still reaches d; only d's own reach (nothing extra) went.
    expect(visible()).toEqual(['a', 'b', 'c', 'd'])
    s.collapseNodeScope('c')
    expect(visible()).toEqual(['a', 'b'])
    expect(useGraphStore.getState().scope.expandedIds?.size).toBe(0)
  })

  it('collapseNodeScope is a no-op for a node that was never expanded', () => {
    const s = useGraphStore.getState()
    s.setScopeToNeighborhood('a', 1)
    const seq = useGraphStore.getState().cameraRequest!.seq
    s.collapseNodeScope('c')
    expect(useGraphStore.getState().cameraRequest!.seq).toBe(seq)
  })

  it('collapseCommunity re-collapses one opened community and collapseAllCommunities every one', () => {
    const s = useGraphStore.getState()
    s.expandCommunity(1)
    s.expandCommunity(2)
    s.collapseCommunity(1)
    expect([...useGraphStore.getState().expandedCommunities]).toEqual([2])
    s.collapseAllCommunities()
    expect(useGraphStore.getState().expandedCommunities.size).toBe(0)
  })
})

describe('local graph controls', () => {
  it('setScopeDepth steps both ways within bounds and re-fits', () => {
    const s = useGraphStore.getState()
    s.setScopeToNeighborhood('a', 1)
    s.setScopeDepth(3)
    expect(visible()).toEqual(['a', 'b', 'c', 'd'])
    s.setScopeDepth(1)
    expect(visible()).toEqual(['a', 'b'])
    s.setScopeDepth(99)
    expect(useGraphStore.getState().scope.depth).toBe(5)
    s.setScopeDepth(0)
    expect(useGraphStore.getState().scope.depth).toBe(1)
  })

  it('setScopeDirection follows links one way, and is remembered across a return to corpus scope', () => {
    const s = useGraphStore.getState()
    s.setScopeToNeighborhood('b', 1)
    s.setScopeDirection('out')
    expect(visible()).toEqual(['b', 'c'])
    s.setScopeDirection('in')
    expect(visible()).toEqual(['a', 'b'])
    s.setScopeToCorpus()
    s.setScopeToNeighborhood('b', 1)
    expect(useGraphStore.getState().scope.direction).toBe('in')
  })
})

describe('visibility facts', () => {
  it('hideNode withholds a node, drops it from the selection, and unhideAllNodes restores it', () => {
    const s = useGraphStore.getState()
    s.selectNode('b')
    s.hideNode('b')
    expect(useGraphStore.getState().visibleNodeIds.has('b')).toBe(false)
    expect(useGraphStore.getState().selectedNodeIds.has('b')).toBe(false)
    s.setFilters([])
    expect(useGraphStore.getState().visibleNodeIds.has('b')).toBe(false)
    s.unhideAllNodes()
    expect(useGraphStore.getState().visibleNodeIds.has('b')).toBe(true)
  })

  it('setShowDangling withholds the broken-link stub and the badge count is untouched', () => {
    const s = useGraphStore.getState()
    const stub = useGraphStore.getState().model!.nodes.find((n) => n.kind === 'dangling')!
    expect(useGraphStore.getState().visibleNodeIds.has(stub.id)).toBe(true)
    s.setShowDangling(false)
    expect(useGraphStore.getState().visibleNodeIds.has(stub.id)).toBe(false)
    expect(useGraphStore.getState().model!.dangling).toHaveLength(1)
  })
})

describe('structural layers', () => {
  it('setSectionNodes rebuilds with ordinal section ids and asks for a run confined to the additions', () => {
    const s = useGraphStore.getState()
    expect(useGraphStore.getState().sectionNodes).toBe(false)
    s.setSectionNodes(true)
    const state = useGraphStore.getState()
    const sections = state.model!.nodes.filter((n) => n.kind === 'section').map((n) => n.id).sort()
    expect(sections).toEqual(['d#Intro#1', 'd#Intro#2'])
    expect(state.layoutState).toBe('requested')
    expect([...state.layoutFree!].sort()).toEqual(['d', 'd#Intro#1', 'd#Intro#2'])
    // Taking the request up consumes the confinement.
    s.setLayoutState('running')
    expect(useGraphStore.getState().layoutFree).toBeNull()
    s.setSectionNodes(false)
    expect(useGraphStore.getState().model!.nodes.some((n) => n.kind === 'section')).toBe(false)
  })

  it('setPromotedField draws anchors for a configured field only, and setPromotedFields replaces the set', () => {
    const s = useGraphStore.getState()
    s.setPromotedField('nope', true)
    expect(useGraphStore.getState().promotedFields.size).toBe(0)
    s.setPromotedField('owner', true)
    const anchors = useGraphStore.getState().model!.nodes.filter((n) => n.kind === 'anchor').map((n) => n.label).sort()
    expect(anchors).toEqual(['team/x', 'team/y'])
    expect(useGraphStore.getState().model!.edges.filter((e) => e.origin === 'anchor')).toHaveLength(5)
    s.setPromotedFields([])
    expect(useGraphStore.getState().model!.nodes.some((n) => n.kind === 'anchor')).toBe(false)
  })
})

describe('saved views', () => {
  it('a saved view carries layers and forces, and never a provisional or derived identity', async () => {
    const s = useGraphStore.getState()
    s.setSectionNodes(true)
    s.setPromotedField('owner', true)
    s.setForces(LAYOUT_FORCES_COMPACT)
    s.setShowDangling(false)
    s.setNodePositions(new Map([
      ['a', { x: 1, y: 1 }],
      ['/root/u.md', { x: 2, y: 2 }],
      ['d#Intro#1', { x: 3, y: 3 }],
      ['anchor:owner:team/x', { x: 4, y: 4 }],
    ]))
    s.togglePin('/root/u.md')
    s.togglePin('a')
    const result = await useGraphStore.getState().saveUserView('layers')
    expect(result.ok).toBe(true)
    const written = setUserConfig.mock.calls[0][0].savedViews[0]
    expect(written.sectionNodes).toBe(true)
    expect(written.promotedFields).toEqual(['owner'])
    expect(written.forces).toEqual(LAYOUT_FORCES_COMPACT)
    expect(written.showDangling).toBe(false)
    const keys = Object.keys(written.positions)
    expect(keys).toEqual(expect.arrayContaining(['a', 'anchor:owner:team/x']))
    expect(keys).not.toContain('/root/u.md')
    expect(keys.some((k) => k.includes('#Intro#'))).toBe(false)
    expect(keys.some((k) => k.startsWith('dangling:'))).toBe(false)
    expect(written.pinned).toEqual(['a'])
  })

  it('isDurableId is false for a path-keyed document, a section, and a dangling stub', () => {
    const s = useGraphStore.getState()
    s.setSectionNodes(true)
    const { isDurableId, model } = useGraphStore.getState()
    expect(isDurableId('a')).toBe(true)
    expect(isDurableId('/root/u.md')).toBe(false)
    expect(isDurableId('d#Intro#1')).toBe(false)
    expect(isDurableId(model!.nodes.find((n) => n.kind === 'dangling')!.id)).toBe(false)
  })
})

describe('section scope', () => {
  /**
   * Sections decompose the documents in view, never a whole corpus: a real
   * 2,192-document corpus produced 39,200 nodes when it decomposed all of
   * them, which stutters under the simulation and cannot be read once it
   * settles.
   */
  async function initWithDocuments(count: number, sections: string[] = ['Intro']): Promise<void> {
    useGraphStore.getState().dispose()
    clearAllSessions()
    const documents: CorpusDocument[] = []
    for (let i = 0; i < count; i++) documents.push(doc(`n${i}`, [], { sections }))
    window.ion = {
      ...window.ion,
      graphCorpusSubscribe: vi.fn(async (): Promise<CorpusSnapshot> => ({
        revision: 1,
        roots: [{ path: '/root', exists: true, documentCount: count }],
        documents,
      })),
    } as unknown as typeof window.ion
    await useGraphStore.getState().init('/root')
    useGraphStore.getState().setLayoutState('settled')
  }

  it('withholds sections and says so when the documents in view carry more than the budget', async () => {
    // The budget counts SECTIONS, not documents: one section each means the
    // corpus has to be budget-sized before it trips.
    const count = SECTION_NODE_BUDGET + 5
    await initWithDocuments(count)
    useGraphStore.getState().setSectionNodes(true)
    const state = useGraphStore.getState()
    expect(state.model!.nodes.some((n) => n.kind === 'section')).toBe(false)
    // Silence would read as a broken toggle; the notice is what makes the
    // remedy (narrow the scope) discoverable.
    expect(state.sectionScopeNotice).toEqual({ sectionCount: count, documentCount: count, budget: SECTION_NODE_BUDGET })
  })

  it('a few documents carrying many headings each trip the budget that a document count would miss', async () => {
    // Forty documents in a real corpus carried 1,482 sections between them,
    // which is why the guard cannot be a document count.
    const headings = Array.from({ length: 200 }, (_, i) => `H${i}`)
    await initWithDocuments(20, headings)
    useGraphStore.getState().setSectionNodes(true)
    const state = useGraphStore.getState()
    expect(state.model!.nodes.some((n) => n.kind === 'section')).toBe(false)
    expect(state.sectionScopeNotice?.documentCount).toBe(20)
    expect(state.sectionScopeNotice?.sectionCount).toBe(4000)
  })

  it('decomposes every document once the scope is inside the limit', async () => {
    await initWithDocuments(10)
    useGraphStore.getState().setSectionNodes(true)
    const state = useGraphStore.getState()
    expect(state.model!.nodes.filter((n) => n.kind === 'section')).toHaveLength(10)
    expect(state.sectionScopeNotice).toBeNull()
  })

  it('a neighbourhood narrows a corpus that was too wide into one that decomposes', async () => {
    await initWithDocuments(SECTION_NODE_BUDGET + 5)
    useGraphStore.getState().setSectionNodes(true)
    expect(useGraphStore.getState().sectionScopeNotice).not.toBeNull()
    // The same corpus, looked at one document at a time, is exactly what
    // sections are for.
    useGraphStore.getState().setScopeToNeighborhood('n0', 1)
    const state = useGraphStore.getState()
    expect(state.sectionScopeNotice).toBeNull()
    expect(state.model!.nodes.some((n) => n.kind === 'section')).toBe(true)
  })
})
