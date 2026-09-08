// @vitest-environment jsdom
/**
 * A graph survives a conversation switch. Switching away parks the session
 * keyed by directory; switching back resumes it whole, with no cold scan
 * and no layout replay. Two conversations on the same directory share one
 * session, because a graph is a picture of a directory rather than of a
 * chat; a worktree is a different directory and gets its own.
 *
 * Memory-only by construction: nothing here touches disk, and the park is
 * a module-level Map that dies with the window.
 */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { useGraphStore } from './graph-store'
import { clearAllSessions, hasParkedSession, parkedPaths } from './session-park'
import { GRAPH_VIEW_DEFAULTS } from '../../../shared/graph-view-types'
import type { GraphViewConfig } from '../../../shared/graph-view-types'
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

function snapshot(dir: string): CorpusSnapshot {
  return {
    revision: 1,
    roots: [{ path: dir, exists: true, documentCount: 2 }],
    documents: [
      { path: `${dir}/a.md`, rootPath: dir, fileName: 'a', frontMatter: { id: 'a' }, wikiLinks: ['b'], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
      { path: `${dir}/b.md`, rootPath: dir, fileName: 'b', frontMatter: { id: 'b' }, wikiLinks: [], markdownLinks: [], sections: [], sizeBytes: 1, modifiedMs: 1 },
    ],
  }
}

let subscribeCalls: string[] = []
let unsubscribeCalls: string[] = []

function installIonStub(): void {
  subscribeCalls = []
  unsubscribeCalls = []
  window.ion = {
    graphViewGetConfig: vi.fn(async (p: string) => config({ corpusRoots: [{ path: p }] })),
    graphViewSetUserConfig: vi.fn(async () => ({ ok: true })),
    onGraphViewConfigChanged: vi.fn(() => () => undefined),
    graphCorpusSubscribe: vi.fn(async (p: string) => {
      subscribeCalls.push(p)
      return snapshot(p)
    }),
    graphCorpusUnsubscribe: vi.fn(async (p: string) => {
      unsubscribeCalls.push(p)
      return { ok: true }
    }),
    onGraphCorpusDelta: vi.fn(() => () => undefined),
  } as unknown as typeof window.ion
}

beforeEach(() => {
  clearAllSessions()
  installIonStub()
})

afterEach(() => {
  clearAllSessions()
  vi.restoreAllMocks()
})

describe('parking on switch-away', () => {
  it('dispose parks the session instead of destroying it', async () => {
    await useGraphStore.getState().init('/repo')
    expect(useGraphStore.getState().model).not.toBeNull()

    useGraphStore.getState().dispose()

    expect(hasParkedSession('/repo')).toBe(true)
    // The live store is cleared: the surface is no longer tracking it.
    expect(useGraphStore.getState().model).toBeNull()
  })

  it('parking does NOT release the corpus subscription, so the scan stays warm', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()
    expect(unsubscribeCalls).toEqual([])
  })

  it('a failed init parks nothing and releases its reference immediately', async () => {
    window.ion.graphCorpusSubscribe = vi.fn(async () => {
      throw new Error('scan failed')
    }) as typeof window.ion.graphCorpusSubscribe

    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()

    expect(hasParkedSession('/repo')).toBe(false)
    expect(unsubscribeCalls).toEqual(['/repo'])
  })
})

describe('resuming on return', () => {
  it('resumes without a second corpus scan', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    expect(subscribeCalls).toEqual(['/repo'])
    expect(useGraphStore.getState().model).not.toBeNull()
  })

  it('does not request a layout run, so the animation never replays', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().setLayoutState('idle')
    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    // 'requested' is what starts a layout run; a resumed session must never
    // be in it. It resumes 'settled' because a parked graph is at rest.
    expect(useGraphStore.getState().layoutState).toBe('settled')
  })

  it('restores selection, filters, bindings, and positions exactly', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().selectNode('a')
    useGraphStore.getState().setFilters([{ dimension: { source: 'structural', metric: 'degree' }, mode: 'include', min: 1 }])
    useGraphStore.getState().setBinding('nodeColor', { source: 'structural', metric: 'community' })
    useGraphStore.getState().setNodePosition('a', 42, -17)
    useGraphStore.getState().togglePin('a')

    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    const s = useGraphStore.getState()
    expect([...s.selectedNodeIds]).toEqual(['a'])
    expect(s.filters).toHaveLength(1)
    expect(s.bindings.nodeColor.dimension).toEqual({ source: 'structural', metric: 'community' })
    expect(s.positions.get('a')).toEqual({ x: 42, y: -17 })
    expect(s.pinnedNodeIds.has('a')).toBe(true)
  })

  it('a resumed session is removed from the park, so it has one owner', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()
    expect(parkedPaths()).toEqual(['/repo'])

    await useGraphStore.getState().init('/repo')
    expect(parkedPaths()).toEqual([])
  })
})

describe('one session per directory', () => {
  it('a different directory gets its own session, parked alongside', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().setNodePosition('a', 1, 1)
    useGraphStore.getState().dispose()

    await useGraphStore.getState().init('/repo/../worktree')
    useGraphStore.getState().dispose()

    expect(parkedPaths().sort()).toEqual(['/repo', '/repo/../worktree'])
  })

  it('switching between two directories resumes each with its own state', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().selectNode('a')
    useGraphStore.getState().dispose()

    await useGraphStore.getState().init('/worktree')
    useGraphStore.getState().selectNode('b')
    useGraphStore.getState().dispose()

    await useGraphStore.getState().init('/repo')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['a'])

    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/worktree')
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['b'])
  })
})

describe('closeSession: the operator is finished with this graph', () => {
  it('drops the parked session and releases the corpus reference', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()

    useGraphStore.getState().closeSession('/repo')

    expect(hasParkedSession('/repo')).toBe(false)
    expect(unsubscribeCalls).toEqual(['/repo'])
  })

  it('clears the live store when closing the directory currently shown', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().closeSession('/repo')

    expect(useGraphStore.getState().model).toBeNull()
    expect(unsubscribeCalls).toEqual(['/repo'])
  })

  it('a later open pays a fresh scan, because the session is genuinely gone', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().dispose()
    useGraphStore.getState().closeSession('/repo')

    await useGraphStore.getState().init('/repo')
    expect(subscribeCalls).toEqual(['/repo', '/repo'])
  })

  it('closing a directory that was never opened is a no-op, not a stray release', () => {
    useGraphStore.getState().closeSession('/never-opened')
    expect(unsubscribeCalls).toEqual([])
  })
})

describe('a parked session resumes at rest, never mid-flight', () => {
  // The canvas owns the layout engine and the camera dedupe counter, and
  // both die when a session parks. Carrying either across produced the
  // observed stall: a session parked mid-drag resumed claiming
  // layoutState 'running', so every camera request deferred behind a run
  // that no longer existed and the camera never moved again.
  it("resumes 'settled' even when parked mid-run", async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().setLayoutState('running')
    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    expect(useGraphStore.getState().layoutState).toBe('settled')
  })

  it('resumes with no pending camera request', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().requestCamera({ kind: 'center-node', nodeId: 'a' })
    expect(useGraphStore.getState().cameraRequest).not.toBeNull()

    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    expect(useGraphStore.getState().cameraRequest).toBeNull()
  })

  it('still restores everything the operator actually set', async () => {
    await useGraphStore.getState().init('/repo')
    useGraphStore.getState().selectNode('a')
    useGraphStore.getState().setLayoutState('running')
    useGraphStore.getState().requestCamera({ kind: 'fit-all' })
    useGraphStore.getState().dispose()
    await useGraphStore.getState().init('/repo')

    // Transient canvas state is dropped; operator state is not.
    expect([...useGraphStore.getState().selectedNodeIds]).toEqual(['a'])
    expect(useGraphStore.getState().model).not.toBeNull()
  })
})
