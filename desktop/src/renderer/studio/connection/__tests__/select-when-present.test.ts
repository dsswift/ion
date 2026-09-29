import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../rendererLogger', () => ({ rInfo: vi.fn(), rWarn: vi.fn() }))

type Listener = () => void
const listeners = new Set<Listener>()
const state: { tabs: Array<{ id: string }>; selectTab: ReturnType<typeof vi.fn> } = { tabs: [], selectTab: vi.fn() }
vi.mock('@ion/server/store/sessionStore', () => ({
  useSessionStore: {
    getState: () => state,
    subscribe: (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn) },
  },
}))
function arrive(id: string): void { state.tabs = [...state.tabs, { id }]; for (const l of listeners) l() }

const { selectTabWhenPresent } = await import('../select-when-present')

describe('selectTabWhenPresent', () => {
  beforeEach(() => { state.tabs = []; state.selectTab = vi.fn(); listeners.clear(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('selects at once when the tab is already in the store', async () => {
    state.tabs = [{ id: 't1' }]
    await expect(selectTabWhenPresent('t1')).resolves.toBe(true)
    expect(state.selectTab).toHaveBeenCalledWith('t1')
  })

  // A remote create: the action result names the tab before that
  // environment's tabs-sync carries it here.
  it('waits for the tab to arrive on a later sync, then selects it and unsubscribes', async () => {
    const p = selectTabWhenPresent('t2', 5000)
    expect(state.selectTab).not.toHaveBeenCalled()
    arrive('other')
    expect(state.selectTab).not.toHaveBeenCalled()
    arrive('t2')
    await expect(p).resolves.toBe(true)
    expect(state.selectTab).toHaveBeenCalledWith('t2')
    expect(listeners.size).toBe(0)
  })

  it('gives up after the timeout without selecting', async () => {
    const p = selectTabWhenPresent('t3', 1000)
    vi.advanceTimersByTime(1001)
    await expect(p).resolves.toBe(false)
    expect(state.selectTab).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })
})
