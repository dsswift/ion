/**
 * loadSkeletonMessages — overlapping loads of one tab's history.
 *
 * The harness here is the one in load-skeleton-messages.test.ts, which covers
 * the hydration path itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@ion/shared/types'

// Full mock (no importOriginal): the real module constructs an Audio() at
// import time, which jsdom-less node lacks. Only the members resume-slice
// uses are needed here.
vi.mock('../session-store-helpers', () => ({
  nextMsgId: (() => {
    let n = 0
    return () => `hist-${++n}`
  })(),
  makeLocalTab: () => ({ id: 'local' }),
  initialPermissionMode: () => 'auto',
}))
vi.mock('../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../persistence/preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))

const mockLoadChainHistory = vi.fn()
const mockLoadTabContentShared = vi.fn()
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  loadChainHistory: (...args: any[]) => mockLoadChainHistory(...args),
  loadTabContent: (...args: any[]) => mockLoadTabContentShared(...args),
}))

import { createResumeSlice } from '../slices/resume-slice'
import { makeMainPane, activeInstance } from '../conversation-instance'
import type { State } from '../session-store-types'

/** Minimal store harness: real slice, fake set/get over a mutable state. */
function makeHarness(paneOverrides: Record<string, unknown>, tabOverrides: Record<string, unknown> = {}) {
  const tab = {
    id: 'tab-1',
    conversationId: 'conv-1',
    historicalSessionIds: ['conv-old'],
    ...tabOverrides,
  }
  let state = {
    tabs: [tab],
    activeTabId: 'tab-1',
    conversationPanes: new Map([['tab-1', makeMainPane(paneOverrides)]]),
  } as unknown as State
  const get = () => state
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function' ? (updater as (s: State) => Partial<State>)(state) : (updater as Partial<State>)
    state = { ...state, ...patch }
  }
  const slice = createResumeSlice(set as never, get as never)
  // rehydrateFailedHistory reaches the reload through get().loadSkeletonMessages
  // (store actions live on state in the real store); mirror that here.
  ;(state as unknown as Record<string, unknown>).loadSkeletonMessages = slice.loadSkeletonMessages
  return {
    load: () => slice.loadSkeletonMessages!('tab-1'),
    rehydrate: () => slice.rehydrateFailedHistory!(),
    inst: () => activeInstance(get().conversationPanes, 'tab-1')!,
    tab: () => get().tabs[0] as unknown as { conversationId: string | null },
    appendLive: (msg: Message) => {
      const pane = state.conversationPanes.get('tab-1')!
      const instances = pane.instances.map((i) => ({ ...i, messages: [...i.messages, msg] }))
      state = {
        ...state,
        conversationPanes: new Map(state.conversationPanes).set('tab-1', { ...pane, instances }),
      } as State
    },
  }
}

beforeEach(() => {
  mockLoadChainHistory.mockReset()
})

// ─── Concurrent-hydration coalescing ──────────────────────────────────────────
//
// REGRESSION PIN for the "message renders several times, fixed by leaving the
// tab and coming back" bug.
//
// loadSkeletonMessages is fired from four independent places that can target
// the same tab in one tick (selectTab, rehydrateFailedHistory, the Studio window dock,
// and the iOS desktop_load_attachments handler via executeJavaScript). It is
// async and its first write lands only after an awaited IPC round-trip, so the
// gates at the top (externalContentStatus / needsHistoryHydration) are read
// before any marker is written: every racing caller passes them, every caller
// loads the same history, and every caller appends it. commitInstance is a
// pure functional update, so the second write does not overwrite the first —
// it appends a SECOND FULL COPY and the transcript renders every row twice.
//
// Re-entering the tab appeared to "fix" it because hydration then
// short-circuited on historyHydrated:true and re-rendered the last clean copy.
//
// These tests fail on the unguarded code (rows appear 2x) and pass with the
// per-tab in-flight promise registry in resume-slice-hydration.ts.

describe('concurrent loadSkeletonMessages (in-flight coalescing)', () => {
  const mockLoadTabContent = mockLoadTabContentShared

  beforeEach(() => {
    mockLoadTabContent.mockReset()
    mockLoadChainHistory.mockReset()
  })

  it('external-content pane: two overlapping loads produce ONE copy of the history', async () => {
    const h = makeHarness({ messages: [], messageCount: 2, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1', instanceId: 'main', schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })
    mockLoadChainHistory.mockResolvedValue([
      { id: 'e1', role: 'user', content: 'hello', timestamp: 2 },
      { id: 'e2', role: 'assistant', content: 'hi', timestamp: 3 },
    ])

    // Both fired BEFORE either resolves — the real race.
    await Promise.all([h.load(), h.load()])

    expect(h.inst().messages.map((m) => m.content)).toEqual(['banner', 'hello', 'hi'])
    expect(h.inst().messageCount).toBe(3)
    // The second caller joined the in-flight load instead of starting its own.
    expect(mockLoadTabContent).toHaveBeenCalledTimes(1)
    expect(mockLoadChainHistory).toHaveBeenCalledTimes(1)
  })

  it('engine-chain pane with legacy rows (no canonical ids) is not duplicated', async () => {
    // Rows without an engine id fall back to a freshly minted id per load, so
    // the id-based liveTail filter cannot dedup them — only the in-flight
    // guard prevents the double append.
    const h = makeHarness({ messages: [], messageCount: 2, historyHydrated: false })
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'hello', timestamp: 2 },
      { role: 'assistant', content: 'hi', timestamp: 3 },
    ])

    await Promise.all([h.load(), h.load()])

    expect(h.inst().messages.map((m) => m.content)).toEqual(['hello', 'hi'])
    expect(mockLoadChainHistory).toHaveBeenCalledTimes(1)
  })

  it('a load AFTER the first completes still short-circuits (guard is not sticky)', async () => {
    const h = makeHarness({ messages: [], messageCount: 2, historyHydrated: false })
    mockLoadChainHistory.mockResolvedValue([
      { id: 'e1', role: 'user', content: 'hello', timestamp: 2 },
    ])

    await h.load()
    expect(h.inst().historyHydrated).toBe(true)
    mockLoadChainHistory.mockClear()

    // Sequential re-entry: the registry entry was released, and the
    // historyHydrated gate is what stops the reload.
    await h.load()
    expect(mockLoadChainHistory).not.toHaveBeenCalled()
    expect(h.inst().messages.map((m) => m.content)).toEqual(['hello'])
  })

  it('a failed load releases the guard so a later retry can run', async () => {
    const h = makeHarness({ messages: [], messageCount: 3, historyHydrated: false })
    mockLoadChainHistory.mockRejectedValueOnce(new Error('engine down'))

    await Promise.all([h.load(), h.load()])
    expect(h.inst().historyHydrationFailed).toBe(true)

    // The rejection must not strand the in-flight entry; rehydrate re-arms and
    // the retry actually issues a new load.
    mockLoadChainHistory.mockResolvedValue([
      { id: 'e1', role: 'user', content: 'recovered', timestamp: 1 },
    ])
    h.rehydrate()
    await new Promise((r) => setTimeout(r, 0))
    expect(h.inst().messages.map((m) => m.content)).toEqual(['recovered'])
  })

  it('external pane: a live row that the reload also returns is not duplicated', async () => {
    // A turn that completes DURING the load appears both in the reloaded
    // history and as the live row already on the pane. The external branch
    // previously kept both (no id filter), unlike the engine-chain branch.
    const h = makeHarness({ messages: [], messageCount: 1, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1', instanceId: 'main', schemaVersion: 4, messages: [],
    })
    mockLoadChainHistory.mockImplementation(async () => {
      // The live row carries the canonical engine id it re-keyed to at
      // message_end — the same id the history row below has.
      h.appendLive({ id: 'e1', role: 'assistant', content: 'the turn', timestamp: 2 })
      return [{ id: 'e1', role: 'assistant', content: 'the turn', timestamp: 2 }]
    })

    await h.load()

    expect(h.inst().messages.map((m) => m.content)).toEqual(['the turn'])
  })
})
