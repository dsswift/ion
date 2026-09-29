/**
 * Boot hydration and persist-on-change: the server has no second in-process
 * writer to converge with, so this only pins load-at-boot, save+publish on a
 * real change, and skip-on-no-op (an unrelated store update, or a change that
 * round-trips back to the same snapshot).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { State } from '../session-store-types'
import type { ExplorerStateSnapshot } from '@ion/shared/explorer-state'

vi.mock('../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

const loadExplorerState = vi.fn()
const saveExplorerState = vi.fn()
const publishExplorerState = vi.fn()

vi.mock('../../explorer-state-store', () => ({
  loadExplorerState: (...args: any[]) => loadExplorerState(...args),
  saveExplorerState: (...args: any[]) => saveExplorerState(...args),
}))
vi.mock('../../ipc/explorer-state', () => ({
  publishExplorerState: (...args: any[]) => publishExplorerState(...args),
}))

const { setupExplorerStateSync, projectExplorerState } = await import('../explorer-state-sync')

const HYDRATED: ExplorerStateSnapshot = {
  version: 1,
  expanded: { '/repo': ['/repo/src'] },
  collapsedRoots: ['/lib/shared'],
  selected: {},
}

/** A store with only the fields and actions the sync touches. */
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

beforeEach(() => {
  loadExplorerState.mockReset().mockReturnValue(HYDRATED)
  saveExplorerState.mockReset()
  publishExplorerState.mockReset()
})

describe('setupExplorerStateSync', () => {
  it('hydrates the tree from disk at boot', () => {
    const store = makeStore()
    setupExplorerStateSync(store)

    expect([...store.getState().fileExplorerStates.get('/repo')!.expandedPaths]).toEqual(['/repo/src'])
    expect(store.getState().fileExplorerRootCollapsed.has('/lib/shared')).toBe(true)
  })

  it('persists and publishes a local expansion, and does not re-publish the value it hydrated', () => {
    const store = makeStore()
    setupExplorerStateSync(store)
    expect(saveExplorerState).not.toHaveBeenCalled()
    expect(publishExplorerState).not.toHaveBeenCalled()

    store.setState({
      fileExplorerStates: new Map([['/repo', { expandedPaths: new Set(['/repo/src', '/repo/docs']), selectedPath: null }]]),
    })

    expect(saveExplorerState).toHaveBeenCalledTimes(1)
    expect(publishExplorerState).toHaveBeenCalledTimes(1)
    expect(publishExplorerState.mock.calls[0]).toEqual([
      expect.objectContaining({ expanded: { '/repo': ['/repo/src', '/repo/docs'] } }),
      'server',
    ])
  })

  it('skips an unrelated store update', () => {
    const store = makeStore()
    setupExplorerStateSync(store)

    store.setState({} as never)

    expect(saveExplorerState).not.toHaveBeenCalled()
    expect(publishExplorerState).not.toHaveBeenCalled()
  })

  it('skips a change that round-trips back to the hydrated snapshot', () => {
    const store = makeStore()
    setupExplorerStateSync(store)

    store.getState().applyExplorerState(projectExplorerState(store.getState()))

    expect(saveExplorerState).not.toHaveBeenCalled()
    expect(publishExplorerState).not.toHaveBeenCalled()
  })

  it('keeps the tree empty when hydration fails', () => {
    loadExplorerState.mockImplementation(() => {
      throw new Error('disk unavailable')
    })
    const store = makeStore()
    expect(() => setupExplorerStateSync(store)).not.toThrow()
    expect(store.getState().fileExplorerStates.size).toBe(0)
  })
})
