// @vitest-environment jsdom
/**
 * Store-level tests for saved views and coarsening (child 08 acceptance):
 * a project view and a user view with the same name both appear with
 * distinct source; a save failure leaves in-memory state unchanged;
 * search index and filter visibility are unaffected by an active
 * coarsening plan (coarsening is render-layer only).
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { computeCoarsening } from './coarsen/coarsen'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
import type { GraphViewConfig, ScopedSavedView } from '../../../shared/graph-view-types'
import type { CorpusSnapshot } from '../../../shared/graph-corpus-types'

function baseConfig(savedViews: ScopedSavedView[] = []): GraphViewConfig {
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
    savedViews,
    defaultView: GRAPH_VIEW_DEFAULTS.defaultView,
    sectionNodes: GRAPH_VIEW_DEFAULTS.sectionNodes,
    sectionTopicsField: GRAPH_VIEW_DEFAULTS.sectionTopicsField,
    neighborhoodDepth: GRAPH_VIEW_DEFAULTS.neighborhoodDepth,
  }
}

function emptyBindings() {
  const b = { dimension: null, valueType: 'categorical' as const }
  return { nodeColor: b, nodeShape: b, nodeSize: b, edgeColor: b, edgeThickness: b, edgeOpacity: b }
}

function installIonStub(config: GraphViewConfig, snapshot: CorpusSnapshot): void {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => config),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
}

afterEach(() => {
  useGraphStore.getState().dispose()
  // The park is module state shared across suites; a stale session would
  // resume into the next test instead of building fresh.
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('saved views scoping', () => {
  it('a project view and a user view with the same name both appear with distinct source', async () => {
    const sharedView: Omit<ScopedSavedView, 'source'> = {
      name: 'Default',
      bindings: emptyBindings(),
      filters: [],
      tagTreatment: 'off',
      clusterRendering: 'hull',
      positions: {},
    }
    const config = baseConfig([
      { ...sharedView, source: 'project' },
      { ...sharedView, source: 'user' },
    ])
    installIonStub(config, { revision: 1, roots: [], documents: [] })
    await useGraphStore.getState().init('/root')
    const views = useGraphStore.getState().config?.savedViews ?? []
    expect(views).toHaveLength(2)
    expect(views.map((v) => v.source).sort()).toEqual(['project', 'user'])
  })

  it('a save failure leaves in-memory state unchanged', async () => {
    const config = baseConfig([])
    installIonStub(config, { revision: 1, roots: [], documents: [] })
    window.ion.graphViewSetUserConfig = vi.fn(async () => ({ ok: false, error: 'disk full' })) as typeof window.ion.graphViewSetUserConfig
    await useGraphStore.getState().init('/root')

    const before = useGraphStore.getState().config
    const result = await useGraphStore.getState().saveUserView('My View')
    expect(result.ok).toBe(false)
    expect(useGraphStore.getState().config).toBe(before)
  })
})

describe('coarsening independence from search and visibility', () => {
  it('the search index and the filter visibility set are unaffected by an active coarsening plan', async () => {
    const config = baseConfig([])
    installIonStub(config, {
      revision: 1,
      roots: [{ path: '/root', exists: true, documentCount: 2 }],
      documents: [
        { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
        { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      ],
    })
    await useGraphStore.getState().init('/root')

    const state = useGraphStore.getState()
    const searchIndexBefore = state.searchIndex
    const visibleBefore = state.visibleNodeIds

    // Compute a coarsening plan (even if it collapses nothing at this
    // scale) and confirm the store's search index and visibility set are
    // untouched by the act of computing it — coarsening only ever
    // transforms the SIGMA graph, never the store's model-derived state.
    computeCoarsening(state.model!, state.visibleNodeIds, 10, new Set(), () => undefined)

    expect(useGraphStore.getState().searchIndex).toBe(searchIndexBefore)
    expect(useGraphStore.getState().visibleNodeIds).toBe(visibleBefore)
  })
})

describe('loading a view re-lays the graph out', () => {
  /**
   * A view's arrangement belongs to the view. Loading one that carries no
   * positions used to leave whatever was on screen before it — an
   * arrangement settled against a different filter set, a different node
   * set, and often different forces — so the new view's data was shown in
   * the old view's shape.
   */
  const snapshot: CorpusSnapshot = {
    revision: 1,
    roots: [{ path: '/root', exists: true, documentCount: 2 }],
    documents: [
      { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: ['b'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
    ],
  }

  function view(overrides: Partial<ScopedSavedView> = {}): ScopedSavedView {
    return { name: 'V', source: 'user', bindings: emptyBindings(), filters: [], tagTreatment: 'off', clusterRendering: 'hull', positions: {}, ...overrides } as ScopedSavedView
  }

  async function ready(): Promise<void> {
    installIonStub(baseConfig([]), snapshot)
    await useGraphStore.getState().init('/root')
    useGraphStore.getState().setLayoutState('settled')
  }

  it('a view with no stored positions discards the previous arrangement and re-settles', async () => {
    await ready()
    useGraphStore.setState({ positions: new Map([['a', { x: 10, y: 20 }]]), pinnedNodeIds: new Set(['a']) })

    useGraphStore.getState().loadView(view())

    const state = useGraphStore.getState()
    expect(state.positions.size).toBe(0)
    expect(state.pinnedNodeIds.size).toBe(0)
    expect(state.layoutState).toBe('requested')
    expect(state.layoutFree).toBeNull()
  })

  it('a view that carries its own positions keeps them — that layout IS the view', async () => {
    await ready()
    useGraphStore.getState().loadView(view({ positions: { a: { x: 7, y: 9 } }, pinned: ['a'] }))

    const state = useGraphStore.getState()
    expect(state.positions.get('a')).toEqual({ x: 7, y: 9 })
    expect([...state.pinnedNodeIds]).toEqual(['a'])
  })
})
