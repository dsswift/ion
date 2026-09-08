// @vitest-environment jsdom
/**
 * The renderer half of the graph tools: each command is applied to the
 * graph store and acknowledged once the render layer has confirmed the
 * picture. The render layer is not mounted here, so a tiny fake stands in
 * for it: it marks each camera request applied and each peek shown, exactly
 * as `GraphCanvas` would once its animation lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sessionState = vi.hoisted(() => ({ tabs: [{ id: 'tab-1', workingDirectory: '/root' }, { id: 'tab-2', workingDirectory: '/other' }], activeTabId: 'tab-1' }))
vi.mock('../../stores/sessionStore', () => ({ useSessionStore: { getState: () => sessionState } }))

const surface = vi.hoisted(() => ({ currentConversationId: 'tab-1' as string | null, openSingleton: vi.fn(), setVisible: vi.fn() }))
vi.mock('../surface/surface-store', () => ({ useSurfaceStore: { getState: () => surface } }))

import { useGraphStore } from './graph-store'
import { clearAllSessions } from './session-park'
import { applyGraphCommand, registerStudioGraphCommands } from './studio-graph-commands'
import { GRAPH_VIEW_DEFAULTS, type GraphViewConfig } from '../../../shared/graph-view-types'
import type { CorpusSnapshot } from '../../../shared/graph-corpus-types'
import type { StudioGraphCommandEnvelope, StudioGraphCommandResult } from '../../../shared/studio-graph-types'

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

/** a → b → c, plus isolated d. */
function chainSnapshot(): CorpusSnapshot {
  const doc = (id: string, links: string[], extra: Record<string, unknown> = {}) => ({
    path: `/root/${id}.md`, rootPath: '/root', fileName: id, frontMatter: { id, status: id === 'd' ? 'draft' : 'final', ...extra },
    wikiLinks: links, markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1,
  })
  return { revision: 1, roots: [{ path: '/root', exists: true, documentCount: 4 }], documents: [doc('a', ['b']), doc('b', ['c']), doc('c', []), doc('d', [])] }
}

let commandHandler: ((envelope: StudioGraphCommandEnvelope) => void) | null = null
const results: StudioGraphCommandResult[] = []

function installIonStub(snapshot: CorpusSnapshot, cfg = config()): void {
  window.ion = {
    graphViewGetConfig: vi.fn(async () => cfg),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async () => snapshot),
    graphCorpusUnsubscribe: vi.fn(async () => ({ ok: true })),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
    onStudioGraphCommand: vi.fn((cb: (envelope: StudioGraphCommandEnvelope) => void) => { commandHandler = cb; return () => { commandHandler = null } }),
    studioGraphCommandResult: vi.fn((result: StudioGraphCommandResult) => { results.push(result) }),
  } as unknown as typeof window.ion
}

/** The render layer's part of the contract: each request is consumed once, by seq, on the next tick. */
function installFakeRenderLayer(): () => void {
  let consumedPeek = 0
  return useGraphStore.subscribe((s) => {
    if (s.cameraRequest && s.cameraAppliedSeq < s.cameraRequest.seq) {
      const seq = s.cameraRequest.seq
      queueMicrotask(() => useGraphStore.getState().noteCameraApplied(seq))
    }
    if (s.peekRequest && s.peekRequest.seq > consumedPeek) {
      consumedPeek = s.peekRequest.seq
      const nodeId = s.peekRequest.nodeId
      queueMicrotask(() => useGraphStore.getState().setQuickPeek(nodeId, { x: 1, y: 1 }))
    }
  })
}

async function openGraph(cfg = config()): Promise<void> {
  installIonStub(chainSnapshot(), cfg)
  await useGraphStore.getState().init('/root')
  useGraphStore.getState().setLayoutState('settled')
}

const base = { conversationId: 'tab-1', cwd: '/root' }
let stopRenderLayer: () => void = () => undefined

beforeEach(() => {
  stopRenderLayer = installFakeRenderLayer()
  surface.currentConversationId = 'tab-1'
  sessionState.activeTabId = 'tab-1'
  surface.openSingleton.mockReset()
  surface.setVisible.mockReset()
  results.length = 0
})

afterEach(() => {
  stopRenderLayer()
  useGraphStore.getState().dispose()
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('open', () => {
  it('refuses every other verb until the graph is open for the directory', async () => {
    installIonStub(chainSnapshot())
    const result = await applyGraphCommand({ kind: 'state', ...base })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('graph_open')
  })

  it('opens the singleton for the on-screen conversation and answers once the graph is built and settled', async () => {
    installIonStub(chainSnapshot())
    // The surface stands in for GraphSurface: opening the tab mounts it,
    // which starts the store on the visible directory.
    surface.openSingleton.mockImplementation(() => {
      void useGraphStore.getState().init('/root').then(() => useGraphStore.getState().setLayoutState('settled'))
    })
    const result = await applyGraphCommand({ kind: 'open', ...base })
    expect(surface.openSingleton).toHaveBeenCalledWith('graph')
    expect(surface.setVisible).toHaveBeenCalledWith(true)
    expect(result.ok).toBe(true)
    expect(result.note).toBeUndefined()
    expect(result.state).toMatchObject({ projectPath: '/root', nodeCount: 4, edgeCount: 2, layoutState: 'settled' })
  })

  it('refuses a background conversation whose graph is not open, and never reveals anything', async () => {
    installIonStub(chainSnapshot())
    surface.currentConversationId = 'tab-2'
    const result = await applyGraphCommand({ kind: 'open', ...base })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('not on screen')
    expect(surface.openSingleton).not.toHaveBeenCalled()
  })

  it('serves a background conversation whose directory is already on stage without revealing', async () => {
    await openGraph()
    surface.currentConversationId = 'tab-2'
    const result = await applyGraphCommand({ kind: 'open', ...base })
    expect(result.ok).toBe(true)
    expect(surface.openSingleton).not.toHaveBeenCalled()
  })

  it('refuses when the visible conversation works in another directory', async () => {
    installIonStub(chainSnapshot())
    const result = await applyGraphCommand({ kind: 'open', conversationId: 'tab-1', cwd: '/elsewhere' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('/root')
    expect(surface.openSingleton).not.toHaveBeenCalled()
  })
})

describe('reading', () => {
  it('search returns described nodes and node returns its edges from its own side', async () => {
    await openGraph()
    const search = await applyGraphCommand({ kind: 'search', ...base, query: 'b', limit: 5 })
    expect(search.ok).toBe(true)
    expect(search.nodes?.map((n) => n.id)).toContain('b')

    const node = await applyGraphCommand({ kind: 'node', ...base, nodeId: 'b' })
    expect(node.node).toMatchObject({ id: 'b', label: 'b', path: '/root/b.md', visible: true })
    // Body links build undirected edges, so both neighbours read as `both`.
    expect(node.neighbors?.map((n) => `${n.direction}:${n.id}`).sort()).toEqual(['both:a', 'both:c'])

    const missing = await applyGraphCommand({ kind: 'node', ...base, nodeId: 'zzz' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('graph_search')
  })

  it('state names bound channels, saved views, and discovered fields', async () => {
    await openGraph(config({ savedViews: [{ name: 'Overview', source: 'project', bindings: useGraphStore.getState().bindings, filters: [], tagTreatment: 'filter', clusterRendering: 'hull', positions: {} }] }))
    useGraphStore.getState().setBinding('nodeColor', { source: 'frontMatter', field: 'status' })
    const result = await applyGraphCommand({ kind: 'state', ...base })
    expect(result.state?.bindings).toEqual({ nodeColor: { source: 'frontMatter', field: 'status' } })
    expect(result.state?.savedViews).toEqual(['Overview'])
    expect(result.state?.discoveredFields).toContain('status')
  })
})

describe('highlight', () => {
  it('sets the agent highlight, frames it, and answers once the camera landed', async () => {
    await openGraph()
    const result = await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a', 'c'], camera: 'fit' })
    expect(result.ok).toBe(true)
    expect(result.note).toBeUndefined()
    const state = useGraphStore.getState()
    expect([...state.agentHighlightNodeIds].sort()).toEqual(['a', 'c'])
    expect(state.cameraRequest).toMatchObject({ kind: 'fit-nodes', nodeIds: ['a', 'c'] })
    expect(state.cameraAppliedSeq).toBe(state.cameraRequest!.seq)
    expect(result.state?.highlightedNodeIds.sort()).toEqual(['a', 'c'])
  })

  it('focus on one node zooms to it; on several it fits them', async () => {
    await openGraph()
    await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a'], camera: 'focus' })
    expect(useGraphStore.getState().cameraRequest).toMatchObject({ kind: 'focus', nodeId: 'a' })
    await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a', 'b'], camera: 'focus' })
    expect(useGraphStore.getState().cameraRequest).toMatchObject({ kind: 'fit-nodes' })
  })

  it('leaves the camera alone with camera none, and notes unknown ids', async () => {
    await openGraph()
    const before = useGraphStore.getState().cameraRequest?.seq ?? 0
    const result = await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a', 'ghost'], camera: 'none' })
    expect(result.ok).toBe(true)
    expect(result.note).toContain('ghost')
    expect(useGraphStore.getState().cameraRequest?.seq ?? 0).toBe(before)
    expect([...useGraphStore.getState().agentHighlightNodeIds]).toEqual(['a'])
  })

  it('refuses when no requested node exists', async () => {
    await openGraph()
    const result = await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['ghost'], camera: 'fit' })
    expect(result.ok).toBe(false)
    expect(useGraphStore.getState().agentHighlightNodeIds.size).toBe(0)
  })

  it('clear-highlight removes it without touching the selection', async () => {
    await openGraph()
    useGraphStore.getState().selectNode('d')
    await applyGraphCommand({ kind: 'highlight', ...base, nodeIds: ['a'], camera: 'none' })
    const result = await applyGraphCommand({ kind: 'clear-highlight', ...base })
    expect(result.state?.highlightedNodeIds).toEqual([])
    expect(result.state?.selectedNodeIds).toEqual(['d'])
  })
})

describe('view changes', () => {
  it('filters replace the rule list and report what is visible', async () => {
    await openGraph()
    const result = await applyGraphCommand({ kind: 'filters', ...base, filters: [{ dimension: { source: 'frontMatter', field: 'status' }, mode: 'exclude', values: ['draft'] }] })
    expect(result.ok).toBe(true)
    expect(result.state?.filters).toHaveLength(1)
    expect(result.state?.visibleCount).toBe(3)
    const cleared = await applyGraphCommand({ kind: 'filters', ...base, filters: [] })
    expect(cleared.state?.visibleCount).toBe(4)
  })

  it('a neighborhood scope waits for the re-frame the store requests', async () => {
    await openGraph()
    const result = await applyGraphCommand({ kind: 'scope', ...base, mode: 'neighborhood', anchorId: 'b', depth: 1 })
    expect(result.ok).toBe(true)
    expect(result.state?.scope).toEqual({ mode: 'neighborhood', anchorId: 'b', depth: 1, direction: 'both' })
    expect(result.state?.visibleCount).toBe(3)
    const state = useGraphStore.getState()
    expect(state.cameraAppliedSeq).toBe(state.cameraRequest!.seq)
    const corpus = await applyGraphCommand({ kind: 'scope', ...base, mode: 'corpus' })
    expect(corpus.state?.scope.mode).toBe('corpus')
  })

  it('load-view lists the available names when the name is unknown', async () => {
    await openGraph(config({ savedViews: [{ name: 'Overview', source: 'user', bindings: useGraphStore.getState().bindings, filters: [], tagTreatment: 'filter', clusterRendering: 'hull', positions: {} }] }))
    const missing = await applyGraphCommand({ kind: 'load-view', ...base, name: 'Nope' })
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('Overview')
    const loaded = await applyGraphCommand({ kind: 'load-view', ...base, name: 'Overview' })
    expect(loaded.ok).toBe(true)
  })

  it('peek opens the card on the node and an omitted id closes it', async () => {
    await openGraph()
    const shown = await applyGraphCommand({ kind: 'peek', ...base, nodeId: 'c' })
    expect(shown.ok).toBe(true)
    expect(shown.note).toBeUndefined()
    expect(useGraphStore.getState().quickPeekNodeId).toBe('c')
    await applyGraphCommand({ kind: 'peek', ...base, nodeId: null })
    expect(useGraphStore.getState().quickPeekNodeId).toBeNull()
  })
})

describe('envelope loop', () => {
  it('answers every envelope exactly once with its callId', async () => {
    await openGraph()
    const stop = registerStudioGraphCommands()
    commandHandler!({ callId: 'c1', command: { kind: 'state', ...base } })
    commandHandler!({ callId: 'c2', command: { kind: 'node', ...base, nodeId: 'ghost' } })
    await vi.waitFor(() => expect(results).toHaveLength(2))
    expect(results.map((r) => [r.callId, r.ok])).toEqual([['c1', true], ['c2', false]])
    stop()
  })
})
