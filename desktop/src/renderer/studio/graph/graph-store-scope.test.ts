// @vitest-environment jsdom
/**
 * Tests for the scope slice: every scope change queues a camera request for
 * what is now visible, and a search jump ends with a focus on the hit so an
 * off-screen result is never selected invisibly.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
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
    promotedFields: [],
    savedViews: [],
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
  }
}

function doc(id: string, links: string[] = []): CorpusDocument {
  return { path: `/root/${id}.md`, rootPath: '/root', fileName: id, frontMatter: { id }, wikiLinks: links, markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 }
}

/** a — b — c — d, plus an isolated e. */
function snapshot(): CorpusSnapshot {
  return {
    revision: 1,
    roots: [{ path: '/root', exists: true, documentCount: 5 }],
    documents: [doc('a', ['b']), doc('b', ['c']), doc('c', ['d']), doc('d'), doc('e')],
  }
}

beforeEach(async () => {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => config()),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot()),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
  await useGraphStore.getState().init('/root')
})

afterEach(() => {
  useGraphStore.getState().dispose()
  // The park is module state shared across suites; a stale session would
  // resume into the next test instead of building fresh.
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('camera requests from scope changes', () => {
  it('init in corpus scope queues a fit-all', () => {
    expect(useGraphStore.getState().cameraRequest).toMatchObject({ kind: 'fit-all' })
  })

  it('a neighborhood scope queues a fit on exactly the visible set', () => {
    useGraphStore.getState().setScopeToNeighborhood('b', 1)
    const request = useGraphStore.getState().cameraRequest
    expect(request?.kind).toBe('fit-nodes')
    expect(request && request.kind === 'fit-nodes' ? [...request.nodeIds].sort() : null).toEqual(['a', 'b', 'c'])
  })

  it('every request carries a new sequence number, even for the same command twice', () => {
    useGraphStore.getState().setScopeToCorpus()
    const first = useGraphStore.getState().cameraRequest!.seq
    useGraphStore.getState().setScopeToCorpus()
    expect(useGraphStore.getState().cameraRequest!.seq).toBeGreaterThan(first)
  })

  it('expanding one hop re-fits on the widened set', () => {
    useGraphStore.getState().setScopeToNeighborhood('a', 1)
    useGraphStore.getState().expandScopeOneHop()
    const request = useGraphStore.getState().cameraRequest
    expect(request && request.kind === 'fit-nodes' ? [...request.nodeIds].sort() : null).toEqual(['a', 'b', 'c'])
  })
})

describe('jumpToSearchResult', () => {
  it('selects, scopes to the neighborhood, and ends with a focus on the hit', () => {
    useGraphStore.getState().jumpToSearchResult('d')
    const state = useGraphStore.getState()
    expect([...state.selectedNodeIds]).toEqual(['d'])
    expect(state.scope).toMatchObject({ mode: 'neighborhood', anchorId: 'd' })
    expect(state.cameraRequest).toMatchObject({ kind: 'focus', nodeId: 'd' })
  })

  it('the focus request is newer than the fit the scope change queued', () => {
    useGraphStore.getState().setScopeToCorpus()
    const before = useGraphStore.getState().cameraRequest!.seq
    useGraphStore.getState().jumpToSearchResult('e')
    const after = useGraphStore.getState().cameraRequest!
    expect(after.kind).toBe('focus')
    // fit-nodes from the scope change, then focus: two requests after `before`.
    expect(after.seq).toBe(before + 2)
  })
})

describe('expandNodeScope', () => {
  it('pulls one node\'s neighbours into a neighborhood scope and re-fits the camera', () => {
    useGraphStore.getState().setScopeToNeighborhood('a', 1)
    expect([...useGraphStore.getState().visibleNodeIds].sort()).toEqual(['a', 'b'])

    useGraphStore.getState().expandNodeScope('d')
    expect([...useGraphStore.getState().visibleNodeIds].sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(useGraphStore.getState().scope.expandedIds?.has('d')).toBe(true)
    const request = useGraphStore.getState().cameraRequest
    expect(request && request.kind === 'fit-nodes' ? [...request.nodeIds].sort() : null).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is a no-op in corpus scope and for an unknown node', () => {
    useGraphStore.getState().setScopeToCorpus()
    const before = useGraphStore.getState().cameraRequest!.seq
    useGraphStore.getState().expandNodeScope('d')
    expect(useGraphStore.getState().scope.expandedIds?.size ?? 0).toBe(0)
    expect(useGraphStore.getState().cameraRequest!.seq).toBe(before)

    useGraphStore.getState().setScopeToNeighborhood('a', 1)
    const afterScope = useGraphStore.getState().cameraRequest!.seq
    useGraphStore.getState().expandNodeScope('ghost')
    expect(useGraphStore.getState().cameraRequest!.seq).toBe(afterScope)
  })

  it('a new anchor or a return to corpus scope clears the expansions', () => {
    useGraphStore.getState().setScopeToNeighborhood('a', 1)
    useGraphStore.getState().expandNodeScope('d')
    useGraphStore.getState().setScopeToNeighborhood('e', 1)
    expect(useGraphStore.getState().scope.expandedIds?.size).toBe(0)

    useGraphStore.getState().expandNodeScope('a')
    useGraphStore.getState().setScopeToCorpus()
    expect(useGraphStore.getState().scope.expandedIds?.size).toBe(0)
  })
})

describe('drillInto', () => {
  it('from corpus scope enters the node\'s neighborhood at the configured depth', () => {
    useGraphStore.getState().setScopeToCorpus()
    useGraphStore.getState().drillInto('b')
    const state = useGraphStore.getState()
    expect(state.scope).toMatchObject({ mode: 'neighborhood', anchorId: 'b', depth: 1 })
    expect([...state.visibleNodeIds].sort()).toEqual(['a', 'b', 'c'])
  })

  it('from inside a neighborhood expands that node', () => {
    useGraphStore.getState().setScopeToNeighborhood('a', 1)
    useGraphStore.getState().drillInto('d')
    const state = useGraphStore.getState()
    expect(state.scope.anchorId).toBe('a')
    expect(state.scope.expandedIds?.has('d')).toBe(true)
    expect([...state.visibleNodeIds].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('ignores a node that is not in the graph', () => {
    useGraphStore.getState().setScopeToCorpus()
    useGraphStore.getState().drillInto('ghost')
    expect(useGraphStore.getState().scope.mode).toBe('corpus')
  })
})

describe('tag treatment', () => {
  // The tag field comes from config. A store-local field that no caller
  // ever set made 'nodes' rebuild the model with no group field and
  // silently produce no tag nodes at all.
  it("'nodes' creates a group node per distinct tag value", () => {
    useGraphStore.setState({
      snapshot: {
        revision: 1,
        roots: [{ path: '/root', exists: true, documentCount: 2 }],
        documents: [
          { ...doc('a'), frontMatter: { id: 'a', tags: ['topic/security', 'topic/azure'] } },
          { ...doc('b'), frontMatter: { id: 'b', tags: ['topic/security'] } },
        ],
      },
    })
    useGraphStore.getState().setTagTreatment('nodes')
    const groups = useGraphStore.getState().model!.nodes.filter((n) => n.kind === 'group')
    expect(groups.map((g) => g.label).sort()).toEqual(['topic/azure', 'topic/security'])
  })

  it("'filter' leaves the node set alone — filtering reads front matter directly", () => {
    useGraphStore.getState().setTagTreatment('filter')
    const groups = useGraphStore.getState().model!.nodes.filter((n) => n.kind === 'group')
    expect(groups).toHaveLength(0)
  })

  it("'off' creates no group nodes", () => {
    useGraphStore.getState().setTagTreatment('off')
    const groups = useGraphStore.getState().model!.nodes.filter((n) => n.kind === 'group')
    expect(groups).toHaveLength(0)
  })
})
