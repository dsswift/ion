import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = {
  activeTabId: 'a' as string | null,
  tabs: [
    { id: 'a', engineProfileId: null, lastVisitedAt: null, manualUnread: true },
    { id: 'b', engineProfileId: 'profile-b', lastVisitedAt: null, manualUnread: true },
  ],
}
let listener: ((next: typeof state) => void) | null = null

const store = {
  getState: () => state,
  setState: (update: ((current: typeof state) => Partial<typeof state>) | Partial<typeof state>) => {
    Object.assign(state, typeof update === 'function' ? update(state) : update)
    listener?.(state)
  },
  subscribe: (next: (next: typeof state) => void) => {
    listener = next
    return () => { listener = null }
  },
}

vi.mock('../stores/sessionStore', () => ({ useSessionStore: store }))

const notifyTabFocus = vi.fn()
;(globalThis as any).window = { ion: { notifyTabFocus } }

describe('initActiveTabNotifier', () => {
  beforeEach(async () => {
    state.activeTabId = 'a'
    state.tabs = [
      { id: 'a', engineProfileId: null, lastVisitedAt: null, manualUnread: true },
      { id: 'b', engineProfileId: 'profile-b', lastVisitedAt: null, manualUnread: true },
    ]
    listener = null
    notifyTabFocus.mockClear()
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(10_000))
  })

  it('stamps initial active tab before publishing focus without recursive repeat', async () => {
    const { initActiveTabNotifier } = await import('./active-tab-notifier')
    const stop = initActiveTabNotifier()

    expect(state.tabs[0]).toMatchObject({ lastVisitedAt: 10_000, manualUnread: false })
    expect(notifyTabFocus).toHaveBeenCalledTimes(1)
    expect(notifyTabFocus).toHaveBeenCalledWith('a', null)
    stop()
  })

  it('stamps each newly active tab and dedupes repeated active ids', async () => {
    const { initActiveTabNotifier } = await import('./active-tab-notifier')
    const stop = initActiveTabNotifier()
    vi.setSystemTime(new Date(20_000))
    store.setState({ activeTabId: 'b' })
    store.setState({ activeTabId: 'b' })

    expect(state.tabs[1]).toMatchObject({ lastVisitedAt: 20_000, manualUnread: false })
    expect(notifyTabFocus).toHaveBeenCalledTimes(2)
    expect(notifyTabFocus).toHaveBeenLastCalledWith('b', 'profile-b')
    stop()
  })
})
