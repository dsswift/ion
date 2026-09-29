import { beforeEach, describe, expect, it, vi } from 'vitest'

interface TestTab {
  id: string
  engineProfileId: string | null
  lastVisitedAt: number | null
  manualUnread: boolean
}

const state: { activeTabId: string | null; tabs: TestTab[] } = {
  activeTabId: 'a' as string | null,
  tabs: [
    { id: 'a', engineProfileId: null, lastVisitedAt: null, manualUnread: true },
    { id: 'b', engineProfileId: 'profile-b', lastVisitedAt: null, manualUnread: true },
  ],
}
let listener: ((next: typeof state) => void) | null = null

const markTabRead = vi.fn((tabId: string) => {
  const visitedAt = Date.now()
  state.tabs = state.tabs.map((tab) => tab.id === tabId
    ? { ...tab, lastVisitedAt: visitedAt, manualUnread: false }
    : tab)
})

const store = {
  getState: () => ({ ...state, markTabRead }),
  setState: (update: ((current: typeof state) => Partial<typeof state>) | Partial<typeof state>) => {
    Object.assign(state, typeof update === 'function' ? update(state) : update)
    listener?.(state)
  },
  subscribe: (next: (next: typeof state) => void) => {
    listener = next
    return () => { listener = null }
  },
}

vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: store }))

import { installFakeWire } from '../host/__tests__/fake-wire'

// The server-side `presence.focus` stub; the loopback wire dispatches to it
// with the packed shape `(tabId, engineProfileId)`.
const notifyTabFocus = vi.fn()
;(globalThis as any).window = { ion: installFakeWire({ notifyTabFocus }) }

describe('initActiveTabNotifier', () => {
  beforeEach(async () => {
    state.activeTabId = 'a'
    state.tabs = [
      { id: 'a', engineProfileId: null, lastVisitedAt: null, manualUnread: true },
      { id: 'b', engineProfileId: 'profile-b', lastVisitedAt: null, manualUnread: true },
    ]
    listener = null
    notifyTabFocus.mockClear()
    markTabRead.mockClear()
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(10_000))
  })

  it('stamps initial active tab before publishing focus without recursive repeat', async () => {
    const { initActiveTabNotifier } = await import('./active-tab-notifier')
    const stop = initActiveTabNotifier()

    expect(state.tabs[0]).toMatchObject({ lastVisitedAt: 10_000, manualUnread: false })
    expect(markTabRead).toHaveBeenCalledWith('a')
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

  it('publishes focus on a browser host too, and never throws on the first tab switch', async () => {
    // No `window.ion` -- the one discriminator `host-instance.ts` uses to
    // resolve `BrowserStudioHost` instead of `ElectronStudioHost`. The verb
    // is `presence.focus` over the wire on every host now; with no wire
    // connected the send is queued or dropped by the host, never thrown.
    delete (globalThis as { window?: { ion?: unknown } }).window?.ion
    ;(globalThis as any).window = {}
    const { initActiveTabNotifier } = await import('./active-tab-notifier')
    expect(() => initActiveTabNotifier()).not.toThrow()
    ;(globalThis as any).window = { ion: installFakeWire({ notifyTabFocus }) }
  })
})
