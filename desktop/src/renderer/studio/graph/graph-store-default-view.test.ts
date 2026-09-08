// @vitest-environment jsdom
/**
 * A configured `defaultView` is applied when the corpus first loads, so a
 * corpus can ship the view it wants an operator to open on. The name is
 * resolved against the concatenated saved-view list; a name matching nothing
 * is skipped rather than failing the load, because a corpus can ship a
 * default whose view a later edit renamed and a graph that refuses to open
 * is worse than one that opens unstyled.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { useSurfaceStore } from '../surface/surface-store'
import { recordTabActivation, clearAllAnchors } from '../surface/editor-anchor'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
import type { GraphViewConfig, ScopedSavedView } from '../../../shared/graph-view-types'
import type { CorpusSnapshot } from '../../../shared/graph-corpus-types'

function config(overrides?: Partial<GraphViewConfig>): GraphViewConfig {
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
    ...overrides,
  }
}

/** A view that is unmistakably distinct from the store's initial state. */
function view(name: string, source: 'project' | 'user' = 'project'): ScopedSavedView {
  return {
    name,
    source,
    bindings: {
      nodeColor: { dimension: { source: 'frontMatter', field: 'type' }, valueType: 'categorical' },
      nodeShape: { dimension: null, valueType: 'categorical' },
      nodeSize: { dimension: { source: 'structural', metric: 'degree' }, valueType: 'numeric' },
      edgeColor: { dimension: null, valueType: 'categorical' },
      edgeThickness: { dimension: null, valueType: 'categorical' },
      edgeOpacity: { dimension: null, valueType: 'categorical' },
    },
    filters: [{ dimension: { source: 'frontMatter', field: 'type' }, mode: 'include', values: ['note'] }],
    tagTreatment: 'nodes',
    clusterRendering: 'border-tint',
    positions: {},
    pinned: [],
  }
}

const snapshot: CorpusSnapshot = {
  revision: 1,
  roots: [{ path: '/root', exists: true, documentCount: 2 }],
  documents: [
    { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a', type: 'note' }, wikiLinks: ['b'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
    { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b', type: 'decision' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
  ],
}

function installIonStub(cfg: GraphViewConfig): void {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => cfg),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
}

afterEach(() => {
  useGraphStore.getState().dispose()
  clearAllAnchors()
  // The park is module state shared across suites; a stale session would
  // resume into the next test instead of building fresh.
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('defaultView on init', () => {
  it('applies the named view: bindings, filters, and treatments all arrive', async () => {
    installIonStub(config({ savedViews: [view('Ops Overview')], defaultView: 'Ops Overview' }))
    await useGraphStore.getState().init('/root')

    const s = useGraphStore.getState()
    expect(s.bindings.nodeColor.dimension).toEqual({ source: 'frontMatter', field: 'type' })
    expect(s.bindings.nodeSize.dimension).toEqual({ source: 'structural', metric: 'degree' })
    expect(s.filters).toHaveLength(1)
    expect(s.tagTreatment).toBe('nodes')
    expect(s.clusterRendering).toBe('border-tint')
  })

  it('the applied filters actually narrow the visible set', async () => {
    installIonStub(config({ savedViews: [view('Ops Overview')], defaultView: 'Ops Overview' }))
    await useGraphStore.getState().init('/root')
    // Only the `note` document passes the view's include rule.
    const s = useGraphStore.getState()
    expect(s.visibleNodeIds.has('a')).toBe(true)
    expect(s.visibleNodeIds.has('b')).toBe(false)
  })

  it('an empty defaultView leaves the store on its own initial state', async () => {
    installIonStub(config({ savedViews: [view('Ops Overview')] }))
    await useGraphStore.getState().init('/root')

    const s = useGraphStore.getState()
    expect(s.bindings.nodeColor.dimension).toBeNull()
    expect(s.filters).toHaveLength(0)
  })

  it('a name matching no saved view is skipped, and the graph still loads', async () => {
    installIonStub(config({ savedViews: [view('Ops Overview')], defaultView: 'Renamed Away' }))
    await useGraphStore.getState().init('/root')

    const s = useGraphStore.getState()
    expect(s.error).toBeNull()
    expect(s.model).not.toBeNull()
    expect(s.bindings.nodeColor.dimension).toBeNull()
  })

  it('resolves against the concatenated list, so a user view can be the default', async () => {
    installIonStub(config({ savedViews: [view('Mine', 'user')], defaultView: 'Mine' }))
    await useGraphStore.getState().init('/root')
    expect(useGraphStore.getState().bindings.nodeColor.dimension).toEqual({ source: 'frontMatter', field: 'type' })
  })

  it('a project view wins over a user view of the same name', async () => {
    const userView = view('Shared', 'user')
    userView.clusterRendering = 'off'
    // savedViews is concatenated project-first, so find() takes the project one.
    installIonStub(config({ savedViews: [view('Shared', 'project'), userView], defaultView: 'Shared' }))
    await useGraphStore.getState().init('/root')
    expect(useGraphStore.getState().clusterRendering).toBe('border-tint')
  })
})

describe('opening scope anchors on the last file the operator read', () => {
  // This is the behaviour section 9 of the design describes and that never
  // once ran: the graph used to read the ACTIVE tab, but opening the graph
  // makes the graph active, so the anchor was always null and every launch
  // fell back to whole-corpus scope.
  it('opens on the anchor file\'s neighborhood, not the whole corpus', async () => {
    useSurfaceStore.setState({ currentConversationId: 'conv-1' })
    recordTabActivation('conv-1', { kind: 'file', id: 'f1', filePath: '/root/a.md', dir: '/root', tabId: 'conv-1' } as never)
    installIonStub(config())
    await useGraphStore.getState().init('/root')

    const s = useGraphStore.getState()
    expect(s.scope.mode).toBe('neighborhood')
    expect(s.scope.anchorId).toBe('a')
  })

  it('falls back to corpus scope when the conversation never opened a file', async () => {
    useSurfaceStore.setState({ currentConversationId: 'conv-2' })
    installIonStub(config())
    await useGraphStore.getState().init('/root')
    expect(useGraphStore.getState().scope.mode).toBe('corpus')
  })

  it('falls back to corpus scope when the anchor file is not in the corpus', async () => {
    useSurfaceStore.setState({ currentConversationId: 'conv-3' })
    recordTabActivation('conv-3', { kind: 'file', id: 'f9', filePath: '/root/not-indexed.txt', dir: '/root', tabId: 'conv-3' } as never)
    installIonStub(config())
    await useGraphStore.getState().init('/root')
    expect(useGraphStore.getState().scope.mode).toBe('corpus')
  })
})
