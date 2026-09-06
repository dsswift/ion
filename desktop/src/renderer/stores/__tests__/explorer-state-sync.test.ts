// @vitest-environment jsdom
/**
 * The convergence funnel: hydrate from main, publish local changes, apply the
 * other window's changes, and never publish an echo back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { State } from '../session-store-types'
import type { ExplorerStateSnapshot } from '../../../shared/explorer-state'
import { setupExplorerStateSync, projectExplorerState } from '../explorer-state-sync'

vi.mock('../../lib/window-role', () => ({ windowRole: () => 'overlay' }))
vi.mock('../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

const HYDRATED: ExplorerStateSnapshot = {
  version: 1,
  expanded: { '/repo': ['/repo/src'] },
  collapsedRoots: ['/lib/shared'],
  selected: {},
}

/** A store with only the fields and actions the funnel touches. */
function makeStore() {
  return createStore<Pick<State, 'fileExplorerStates' | 'fileExplorerRootCollapsed' | 'applyExplorerState'>>(
    (set) => ({
      fileExplorerStates: new Map(),
      fileExplorerRootCollapsed: new Set<string>(),
      applyExplorerState: (snapshot) => {
        const states = new Map<string, { expandedPaths: Set<string>; selectedPath: string | null }>()
        for (const [root, paths] of Object.entries(snapshot.expanded)) {
          states.set(root, { expandedPaths: new Set(paths), selectedPath: snapshot.selected[root] ?? null })
        }
        set({ fileExplorerStates: states, fileExplorerRootCollapsed: new Set(snapshot.collapsedRoots) })
      },
    }),
  ) as unknown as import('zustand').StoreApi<State>
}

let publish: ReturnType<typeof vi.fn>
let broadcastHandler: ((payload: { snapshot: ExplorerStateSnapshot; origin: string }) => void) | null

beforeEach(() => {
  publish = vi.fn()
  broadcastHandler = null
  ;(window as unknown as { ion: unknown }).ion = {
    loadExplorerState: vi.fn().mockResolvedValue(HYDRATED),
    publishExplorerState: publish,
    onExplorerStateChanged: (callback: (payload: { snapshot: ExplorerStateSnapshot; origin: string }) => void) => {
      broadcastHandler = callback
      return () => { broadcastHandler = null }
    },
  }
})

describe('setupExplorerStateSync', () => {
  it('hydrates the tree from main at boot', async () => {
    const store = makeStore()
    setupExplorerStateSync(store)
    await vi.waitFor(() => expect(store.getState().fileExplorerStates.size).toBe(1))

    expect([...store.getState().fileExplorerStates.get('/repo')!.expandedPaths]).toEqual(['/repo/src'])
    expect(store.getState().fileExplorerRootCollapsed.has('/lib/shared')).toBe(true)
  })

  it('publishes a local expansion, and does not re-publish the value it hydrated', async () => {
    const store = makeStore()
    setupExplorerStateSync(store)
    await vi.waitFor(() => expect(store.getState().fileExplorerStates.size).toBe(1))
    expect(publish).not.toHaveBeenCalled()

    store.setState({
      fileExplorerStates: new Map([['/repo', { expandedPaths: new Set(['/repo/src', '/repo/docs']), selectedPath: null }]]),
    })

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0]).toEqual({
      origin: 'overlay',
      snapshot: expect.objectContaining({ expanded: { '/repo': ['/repo/src', '/repo/docs'] } }),
    })
  })

  it("applies the other window's change without publishing it back", async () => {
    const store = makeStore()
    setupExplorerStateSync(store)
    await vi.waitFor(() => expect(broadcastHandler).not.toBeNull())

    broadcastHandler!({
      origin: 'studio',
      snapshot: { version: 1, expanded: { '/repo': ['/repo/docs'] }, collapsedRoots: [], selected: {} },
    })

    expect([...store.getState().fileExplorerStates.get('/repo')!.expandedPaths]).toEqual(['/repo/docs'])
    // Publishing it back is what would ping-pong the two windows forever.
    expect(publish).not.toHaveBeenCalled()
  })

  it('ignores its own echo', async () => {
    const store = makeStore()
    setupExplorerStateSync(store)
    await vi.waitFor(() => expect(broadcastHandler).not.toBeNull())
    store.setState({
      fileExplorerStates: new Map([['/repo', { expandedPaths: new Set(['/repo/src', '/repo/docs']), selectedPath: null }]]),
    })
    publish.mockClear()

    broadcastHandler!({ origin: 'overlay', snapshot: publishedSnapshot(store) })

    expect(publish).not.toHaveBeenCalled()
    expect([...store.getState().fileExplorerStates.get('/repo')!.expandedPaths]).toEqual(['/repo/src', '/repo/docs'])
  })

  it('leaves the tree window-local when the bridge is missing', () => {
    ;(window as unknown as { ion: unknown }).ion = {}
    const store = makeStore()
    expect(() => setupExplorerStateSync(store)).not.toThrow()
  })
})

function publishedSnapshot(store: import('zustand').StoreApi<State>): ExplorerStateSnapshot {
  return projectExplorerState(store.getState())
}
