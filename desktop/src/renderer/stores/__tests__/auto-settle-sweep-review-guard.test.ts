import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for a reported bug: opening an old settled conversation
 * from Settled History for read-only review silently re-dated it as an
 * auto-settle from today, destroying its real settledAt/settledOverride.
 *
 * Mechanism: `selectTab` (tab-slice.ts) splices a settled-history record into
 * the live `tabs` array so the operator can read it, and deliberately leaves
 * its settled marker (`settledOverride`) in place so navigating away re-files
 * it unchanged (see the "returns a settled review tab to history" case in
 * close-settle-flow.test.ts). The once-a-minute sweep in auto-settle-sweep.ts
 * scans every tab in that same array; before this fix it had no awareness that
 * a tab could already be settled, so it re-ran `autoSettleTab` on the review
 * tab, overwriting its provenance to `'auto'` and its `settledAt` to "now".
 *
 * Both layers are pinned here: the sweep must skip an already-settled tab
 * before calling `autoSettleTab` at all, and `autoSettleTab`'s own mutation
 * must refuse to re-settle a tab that already carries a settled marker, so a
 * future caller cannot reintroduce the bug by skipping the sweep's filter.
 */

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rWarn: vi.fn(), rDebug: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: vi.fn() },
}))

import { startAutoSettleSweep } from '../auto-settle-sweep'
import { createInboxSlice } from '../slices/inbox-slice'
import { usePreferencesStore } from '../../preferences'
import type { State, StoreGet, StoreSet } from '../session-store-types'

const stopEngine = vi.fn()

function reviewTab(overrides: Record<string, unknown> = {}) {
  return {
    id: 'review-me',
    title: 'ai.dcim.com',
    customTitle: null,
    workingDirectory: '/repo',
    status: 'idle',
    // A genuinely old settle, exactly like the reported 17-day-old record.
    settledOverride: 'settled' as const,
    settledAt: Date.now() - 17 * 24 * 60 * 60 * 1000,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    lastCompletionAt: null,
    // Old enough that the auto-settle clock would fire if the review guard
    // did not skip it first.
    lastMessageAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    lastActivityAt: null,
    manualUnread: false,
    conversationId: 'conversation-review-me',
    lastKnownSessionId: null,
    historicalSessionIds: [],
    isTerminalOnly: false,
    worktree: null,
    pinnedAt: null,
    pinOrderKey: null,
    inputLocked: true,
    inputLockReason: 'settled' as const,
    ...overrides,
  }
}

function pane() {
  return {
    activeInstanceId: 'main',
    instances: [{
      id: 'main',
      messages: [],
      messageCount: 0,
      statusFields: { state: 'idle' },
      agentStates: [],
      permissionQueue: [],
      elicitationQueue: [],
      permissionDenied: null,
      planFilePath: null,
    }],
  }
}

function buildStore() {
  let state: Record<string, unknown> = {
    tabs: [reviewTab()],
    settledHistory: [],
    conversationPanes: new Map([['review-me', pane()]]),
    loadSkeletonMessages: vi.fn().mockResolvedValue(undefined),
  }
  const set = ((patch: unknown) => {
    const next = typeof patch === 'function'
      ? (patch as (current: Record<string, unknown>) => Record<string, unknown>)(state)
      : patch as Record<string, unknown>
    state = { ...state, ...next }
  }) as StoreSet
  const get = (() => state) as unknown as StoreGet
  state = { ...state, ...createInboxSlice(set, get) }
  return {
    getState: () => state as unknown as State,
    setState: set,
    subscribe: vi.fn(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(usePreferencesStore.getState).mockReturnValue({ inboxAutoSettleDays: 3 } as never)
  stopEngine.mockReset().mockResolvedValue(undefined)
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    ion: { engineStop: stopEngine },
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('auto-settle sweep skips a tab already under settled review', () => {
  it('never calls the engine or rewrites settledAt/settledOverride on the review tab', async () => {
    const store = buildStore() as unknown as Parameters<typeof startAutoSettleSweep>[0]
    const originalSettledAt = store.getState().tabs[0].settledAt
    const stop = startAutoSettleSweep(store)

    await vi.advanceTimersByTimeAsync(60_000)
    // Allow the fire-and-forget autoSettleTab promise chain to flush.
    await Promise.resolve()
    await Promise.resolve()

    expect(stopEngine).not.toHaveBeenCalled()
    const tab = store.getState().tabs.find((candidate) => candidate.id === 'review-me')
    expect(tab?.settledOverride).toBe('settled')
    expect(tab?.settledAt).toBe(originalSettledAt)
    expect(store.getState().settledHistory).toEqual([])

    stop()
  })

  it('refuses at the mutation itself even if a future caller skips the sweep filter', async () => {
    const store = buildStore()
    const originalSettledAt = store.getState().tabs[0].settledAt

    // Call the underlying action directly, bypassing the sweep's own guard,
    // to prove the mutation is safe on its own and not only behind one caller.
    await store.getState().autoSettleTab('review-me')

    expect(stopEngine).not.toHaveBeenCalled()
    const tab = store.getState().tabs.find((candidate) => candidate.id === 'review-me')
    expect(tab?.settledOverride).toBe('settled')
    expect(tab?.settledAt).toBe(originalSettledAt)
    expect(store.getState().settledHistory).toEqual([])
  })

  it('still auto-settles a genuinely unsettled, qualifying tab', async () => {
    const store = buildStore()
    ;(store.setState as unknown as (patch: (state: Record<string, unknown>) => Record<string, unknown>) => void)((state) => ({
      tabs: [{
        ...(state.tabs as Record<string, unknown>[])[0],
        settledOverride: null,
        settledAt: null,
        inputLocked: false,
        inputLockReason: null,
      }],
    }))

    const stop = startAutoSettleSweep(store as unknown as Parameters<typeof startAutoSettleSweep>[0])
    await vi.advanceTimersByTimeAsync(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(stopEngine).toHaveBeenCalledWith('review-me')
    expect(store.getState().settledHistory[0]).toMatchObject({ settledOverride: 'auto' })

    stop()
  })
})
