// @vitest-environment jsdom
/**
 * Tests for graph-store.ts (child 05): delta application, selection, and
 * the unconfigured state. `window.ion` is stubbed per-test.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
import type { GraphViewConfig } from '../../../shared/graph-view-types'
import type { CorpusSnapshot, CorpusWatchState } from '../../../shared/graph-corpus-types'

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

function installIonStub(overrides?: Partial<typeof window.ion>): void {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => config()),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async (): Promise<CorpusSnapshot> => ({ revision: 1, roots: [], documents: [] })),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as typeof window.ion
}

afterEach(() => {
  useGraphStore.getState().dispose()
  // The park is module state shared across suites; a stale session would
  // resume into the next test instead of building fresh.
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('init / availability', () => {
  it('does not let an older config reply overwrite a newer project', async () => {
    let resolveFirst: ((value: GraphViewConfig) => void) | undefined
    const first = new Promise<GraphViewConfig>((resolve) => { resolveFirst = resolve })
    installIonStub({
      graphViewGetConfig: vi.fn((path: string) => path === '/first' ? first : Promise.resolve(config({ corpusRoots: [{ path: '/second' }] }))),
      graphCorpusSubscribe: vi.fn(async () => ({ revision: 1, roots: [], documents: [] })),
    })

    const firstInit = useGraphStore.getState().init('/first')
    await Promise.resolve()
    const secondInit = useGraphStore.getState().init('/second')
    resolveFirst?.(config({ corpusRoots: [{ path: '/first' }] }))
    await Promise.all([firstInit, secondInit])

    expect(useGraphStore.getState().projectPath).toBe('/second')
    expect(useGraphStore.getState().config?.corpusRoots).toEqual([{ path: '/second' }])
    expect(window.ion.graphCorpusSubscribe).not.toHaveBeenCalledWith('/first')
  })

  it('an unconfigured project reports available:false and performs no subscribe', async () => {
    installIonStub({ graphViewGetConfig: vi.fn(async () => config({ corpusRoots: [] })) })
    await useGraphStore.getState().init('/project')
    expect(useGraphStore.getState().available).toBe(false)
    expect(window.ion.graphCorpusSubscribe).not.toHaveBeenCalled()
  })

  it('a configured project subscribes and builds a model', async () => {
    installIonStub({
      graphViewGetConfig: vi.fn(async () => config({ corpusRoots: [{ path: '/root' }] })),
      graphCorpusSubscribe: vi.fn(async () => ({
        revision: 1,
        roots: [{ path: '/root', exists: true, documentCount: 1 }],
        documents: [
          { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
        ],
        watchState: 'watching' as CorpusWatchState,
      })),
    })
    await useGraphStore.getState().init('/project')
    const state = useGraphStore.getState()
    expect(state.available).toBe(true)
    expect(state.watchState).toBe('watching')
    expect(state.model?.nodes).toHaveLength(1)
  })
})

describe('applyDelta', () => {
  beforeEach(async () => {
    installIonStub({
      graphViewGetConfig: vi.fn(async () => config({ corpusRoots: [{ path: '/root' }] })),
      graphCorpusSubscribe: vi.fn(async () => ({
        revision: 1,
        roots: [{ path: '/root', exists: true, documentCount: 1 }],
        documents: [
          { path: '/root/a.md', rootPath: '/root', fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
        ],
      })),
    })
    await useGraphStore.getState().init('/project')
  })

  it('an upsert patches the snapshot by path and rebuilds the model', () => {
    useGraphStore.getState().applyDelta({
      revision: 2,
      upserted: [
        { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      ],
      removedPaths: [],
      roots: [{ path: '/root', exists: true, documentCount: 2 }],
    })
    const state = useGraphStore.getState()
    expect(state.snapshot?.documents).toHaveLength(2)
    expect(state.model?.nodes.some((n) => n.id === 'b')).toBe(true)
  })

  it('a roots-only delta carrying watchState downgrades the store to partial', () => {
    useGraphStore.getState().applyDelta({
      revision: 2,
      upserted: [],
      removedPaths: [],
      roots: [{ path: '/root', exists: true, documentCount: 1, watch: 'failed' }],
      watchState: 'partial',
    })
    const state = useGraphStore.getState()
    expect(state.watchState).toBe('partial')
    expect(state.snapshot?.watchState).toBe('partial')
    expect(state.snapshot?.documents).toHaveLength(1)
  })

  it('a delta without watchState leaves the previous watch state in place', () => {
    useGraphStore.getState().applyDelta({ revision: 2, upserted: [], removedPaths: [], roots: [{ path: '/root', exists: true, documentCount: 1 }], watchState: 'partial' })
    useGraphStore.getState().applyDelta({ revision: 3, upserted: [], removedPaths: [], roots: [{ path: '/root', exists: true, documentCount: 1 }] })
    expect(useGraphStore.getState().watchState).toBe('partial')
  })

  it('a removal drops the node from the model', () => {
    useGraphStore.getState().applyDelta({
      revision: 2,
      upserted: [],
      removedPaths: ['/root/a.md'],
      roots: [{ path: '/root', exists: true, documentCount: 0 }],
    })
    const state = useGraphStore.getState()
    expect(state.snapshot?.documents).toHaveLength(0)
    expect(state.model?.nodes.some((n) => n.id === 'a')).toBe(false)
  })

  it('carries settled positions across a rebuild instead of re-seeding the layout', () => {
    // Regression: a rebuild returns a NEW graphology instance, so a node
    // whose position lives only on the old instance was re-placed on the
    // fallback jitter circle — every corpus delta collapsed the settled
    // layout into a blob, with no layout restart to recover from it.
    const before = useGraphStore.getState().graph!
    before.setNodeAttribute('a', 'x', 123)
    before.setNodeAttribute('a', 'y', 456)

    useGraphStore.getState().applyDelta({
      revision: 2,
      upserted: [
        { path: '/root/b.md', rootPath: '/root', fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      ],
      removedPaths: [],
      roots: [{ path: '/root', exists: true, documentCount: 2 }],
    })

    const after = useGraphStore.getState().graph!
    expect(after).not.toBe(before)
    expect(after.getNodeAttribute('a', 'x')).toBe(123)
    expect(after.getNodeAttribute('a', 'y')).toBe(456)
    expect(useGraphStore.getState().positions.get('a')).toEqual({ x: 123, y: 456 })
  })

  it('selection clears when the selected node is removed', () => {
    useGraphStore.getState().selectNode('a')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['a'])
    useGraphStore.getState().applyDelta({
      revision: 2,
      upserted: [],
      removedPaths: ['/root/a.md'],
      roots: [{ path: '/root', exists: true, documentCount: 0 }],
    })
    expect(useGraphStore.getState().selectedNodeIds.size).toBe(0)
    expect(useGraphStore.getState().emphasisNodeIds.size).toBe(0)
  })
})

describe('positionsEpoch: which position writes re-enter the canvas sync', () => {
  // The canvas sync writes the store's positions onto the graph the layout
  // worker is simulating, and the convergence monitor measures settledness
  // by watching exactly those writes. So a write-back HARVESTED from the
  // graph must not trigger a sync: it would read as movement, reset the
  // still-run counter, and the run would never cool. Observed as nodes
  // shaking after a drop with no `layout cooled` line for that run.
  it('a harvested write-back does not advance the epoch', () => {
    const before = useGraphStore.getState().positionsEpoch
    useGraphStore.getState().setNodePositions(new Map([['a', { x: 1, y: 2 }]]))
    expect(useGraphStore.getState().positionsEpoch).toBe(before)
    // The value still lands: it is remembered, just not re-synced.
    expect(useGraphStore.getState().positions.get('a')).toEqual({ x: 1, y: 2 })
  })

  it('a whole settled layout write-back does not advance the epoch', () => {
    const before = useGraphStore.getState().positionsEpoch
    const harvested = new Map([['a', { x: 1, y: 1 }], ['b', { x: 2, y: 2 }], ['c', { x: 3, y: 3 }]])
    useGraphStore.getState().setNodePositions(harvested)
    expect(useGraphStore.getState().positionsEpoch).toBe(before)
  })

  it('a coordinate the graph does not have yet DOES advance the epoch', () => {
    const before = useGraphStore.getState().positionsEpoch
    useGraphStore.getState().setNodePosition('a', 10, 20)
    expect(useGraphStore.getState().positionsEpoch).toBe(before + 1)
    expect(useGraphStore.getState().positions.get('a')).toEqual({ x: 10, y: 20 })
  })

  it('loading a saved view advances the epoch once per stored position', () => {
    const before = useGraphStore.getState().positionsEpoch
    useGraphStore.getState().setNodePosition('a', 1, 1)
    useGraphStore.getState().setNodePosition('b', 2, 2)
    expect(useGraphStore.getState().positionsEpoch).toBe(before + 2)
  })

  it('an empty write-back is inert', () => {
    const before = useGraphStore.getState().positionsEpoch
    const positionsBefore = useGraphStore.getState().positions
    useGraphStore.getState().setNodePositions(new Map())
    expect(useGraphStore.getState().positionsEpoch).toBe(before)
    expect(useGraphStore.getState().positions).toBe(positionsBefore)
  })
})

describe('resetLayout', () => {
  /**
   * The way back from an arrangement the operator has pushed out of shape.
   * A reset that kept the dragged positions or the pins would seed the new
   * run from the very layout it was asked to undo.
   */
  it('drops every dragged position and pin and asks for an unconfined layout', () => {
    useGraphStore.setState({
      positions: new Map([['a', { x: 1, y: 2 }], ['b', { x: 3, y: 4 }]]),
      pinnedNodeIds: new Set(['a']),
      layoutFree: new Set(['b']),
      layoutState: 'settled',
    })
    const epochBefore = useGraphStore.getState().positionsEpoch

    useGraphStore.getState().resetLayout()

    const s = useGraphStore.getState()
    expect(s.positions.size).toBe(0)
    expect(s.pinnedNodeIds.size).toBe(0)
    // Unconfined: a confined request skips seeding and moves a subset,
    // which is the opposite of a reset.
    expect(s.layoutFree).toBeNull()
    expect(s.layoutState).toBe('requested')
    // The canvas syncs positions onto the graph only when the epoch moves.
    expect(s.positionsEpoch).toBeGreaterThan(epochBefore)
  })

  it('clears the fixed flag every pinned node left on the graph', async () => {
    const { default: Graph } = await import('graphology')
    const g = new Graph()
    g.addNode('a', { x: 0, y: 0, fixed: true })
    g.addNode('b', { x: 1, y: 1, fixed: false })
    useGraphStore.setState({ graph: g, pinnedNodeIds: new Set(['a']) })

    useGraphStore.getState().resetLayout()

    expect(g.getNodeAttribute('a', 'fixed')).toBe(false)
    expect(g.getNodeAttribute('b', 'fixed')).toBe(false)
  })
})
