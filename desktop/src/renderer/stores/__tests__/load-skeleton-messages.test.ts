/**
 * loadSkeletonMessages — the lazy history hydration path, and the
 * historyHydrated marker that gates it.
 *
 * Regression pin for the ATV last-turn-only bug: live streamed events append
 * to a never-hydrated skeleton pane, so the old "messages.length > 0 →
 * already loaded" short-circuit skipped the history load entirely and the
 * transcript showed only the live tail. The poisoned-pane tests here FAIL on
 * that code (it returns before calling loadChainHistory) and pass with the
 * precise needsHistoryHydration gate + baseline merge.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '../../../shared/types'

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
vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))

import { createResumeSlice } from '../slices/resume-slice'
import { makeMainPane, activeInstance, needsHistoryHydration } from '../conversation-instance'
import type { State } from '../session-store-types'

const mockLoadChainHistory = vi.fn()

function liveMsg(id: string, content: string): Message {
  return { id, role: 'assistant', content, timestamp: 0 }
}

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
    conversationPanes: new Map([['tab-1', makeMainPane(paneOverrides)]]),
  } as unknown as State
  const get = () => state
  const set = (updater: unknown) => {
    const patch = typeof updater === 'function' ? (updater as (s: State) => Partial<State>)(state) : (updater as Partial<State>)
    state = { ...state, ...patch }
  }
  const slice = createResumeSlice(set as never, get as never)
  return {
    load: () => slice.loadSkeletonMessages!('tab-1'),
    inst: () => activeInstance(get().conversationPanes, 'tab-1')!,
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
  ;(globalThis as { window?: unknown }).window = {
    ...(globalThis as { window?: object }).window,
    ion: { loadChainHistory: mockLoadChainHistory },
  }
})

describe('loadSkeletonMessages', () => {
  it('hydrates a clean skeleton (empty messages, persisted count)', async () => {
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'first answer' },
    ])
    const h = makeHarness({ messages: [], messageCount: 2, historyHydrated: false })
    await h.load()
    expect(mockLoadChainHistory).toHaveBeenCalledWith(['conv-old', 'conv-1'])
    expect(h.inst().messages.map((m) => m.content)).toEqual(['first prompt', 'first answer'])
    expect(h.inst().historyHydrated).toBe(true)
  })

  it('REGRESSION: a poisoned skeleton (live messages landed first) still loads full history', async () => {
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'old turn 1' },
      { role: 'assistant', content: 'old answer 1' },
      { role: 'assistant', content: 'the live turn, as persisted' },
    ])
    // The reported bug: only the last live turn present, full history missing.
    const h = makeHarness({
      messages: [liveMsg('live-1', 'the live turn, as persisted')],
      messageCount: 1,
      historyHydrated: false,
    })
    await h.load()
    // Old code returned here without calling loadChainHistory at all.
    expect(mockLoadChainHistory).toHaveBeenCalledTimes(1)
    // Pre-load live messages are REPLACED by history (which contains them).
    expect(h.inst().messages.map((m) => m.content)).toEqual([
      'old turn 1',
      'old answer 1',
      'the live turn, as persisted',
    ])
    expect(h.inst().historyHydrated).toBe(true)
  })

  it('keeps live messages that stream in DURING the load (baseline merge)', async () => {
    const h = makeHarness({ messages: [liveMsg('pre', 'pre-load live')], messageCount: 1, historyHydrated: false })
    mockLoadChainHistory.mockImplementation(async () => {
      // A new message arrives while the history IPC is in flight.
      h.appendLive(liveMsg('mid', 'streamed during load'))
      return [{ role: 'assistant', content: 'persisted history' }]
    })
    await h.load()
    expect(h.inst().messages.map((m) => m.content)).toEqual(['persisted history', 'streamed during load'])
    expect(h.inst().messageCount).toBe(2)
  })

  it('already-hydrated instances short-circuit (no reload on re-select)', async () => {
    const h = makeHarness({ messages: [liveMsg('a', 'loaded')], messageCount: 1, historyHydrated: true })
    await h.load()
    expect(mockLoadChainHistory).not.toHaveBeenCalled()
  })

  it('legacy panes (no marker) keep the empty+count heuristic', async () => {
    mockLoadChainHistory.mockResolvedValue([{ role: 'user', content: 'hi' }])
    const h = makeHarness({ messages: [], messageCount: 1 })
    await h.load()
    expect(mockLoadChainHistory).toHaveBeenCalledTimes(1)
    // And legacy panes WITH messages are treated as loaded (unchanged behavior).
    mockLoadChainHistory.mockClear()
    const h2 = makeHarness({ messages: [liveMsg('a', 'x')], messageCount: 1 })
    await h2.load()
    expect(mockLoadChainHistory).not.toHaveBeenCalled()
  })

  it('load failure keeps live messages and marks hydrated (no retry loop)', async () => {
    mockLoadChainHistory.mockRejectedValue(new Error('ipc down'))
    const h = makeHarness({ messages: [liveMsg('live', 'live only')], messageCount: 5, historyHydrated: false })
    await h.load()
    expect(h.inst().messages.map((m) => m.content)).toEqual(['live only'])
    expect(h.inst().messageCount).toBe(1)
    expect(h.inst().historyHydrated).toBe(true)
    expect(needsHistoryHydration(h.inst())).toBe(false)
  })
})

describe('needsHistoryHydration', () => {
  it('truth table', () => {
    const base = makeMainPane().instances[0]
    expect(needsHistoryHydration(null)).toBe(false)
    expect(needsHistoryHydration({ ...base, historyHydrated: true, messages: [], messageCount: 9 })).toBe(false)
    expect(needsHistoryHydration({ ...base, historyHydrated: false, messages: [], messageCount: 9 })).toBe(true)
    // The bug case: unhydrated pane with live messages still needs hydration.
    expect(needsHistoryHydration({ ...base, historyHydrated: false, messages: [liveMsg('a', 'x')], messageCount: 1 })).toBe(true)
    // Unhydrated but genuinely empty conversation: nothing to load.
    expect(needsHistoryHydration({ ...base, historyHydrated: false, messages: [], messageCount: 0 })).toBe(false)
    // Legacy (undefined marker): original heuristic.
    expect(needsHistoryHydration({ ...base, messages: [], messageCount: 3 })).toBe(true)
    expect(needsHistoryHydration({ ...base, messages: [liveMsg('a', 'x')], messageCount: 1 })).toBe(false)
  })
})

// ─── Schema v4: externalized content lazy-load ────────────────────────────────

describe('loadSkeletonMessages — externalized content (schema v4)', () => {
  const mockLoadTabContent = vi.fn()

  beforeEach(() => {
    mockLoadTabContent.mockReset()
    mockLoadChainHistory.mockReset()
    ;(globalThis as { window?: { ion?: object } }).window!.ion = {
      loadChainHistory: mockLoadChainHistory,
      loadTabContent: mockLoadTabContent,
    } as never
  })

  it('merges engine chain rows with renderer-only rows from content file', async () => {
    // The core regression fix: a stale content file has only a harness row;
    // the engine chain has the real conversation. Both must appear in the pane.
    const h = makeHarness({ messages: [], messageCount: 2, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1',
      instanceId: 'main',
      schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'hello', timestamp: 2 },
      { role: 'assistant', content: 'hi', timestamp: 3 },
    ])

    await h.load()

    expect(mockLoadTabContent).toHaveBeenCalledWith('tab-1')
    expect(mockLoadChainHistory).toHaveBeenCalledWith(['conv-old', 'conv-1'])
    const inst = h.inst()
    // Sorted by timestamp: harness(1), user(2), assistant(3)
    expect(inst.messages).toHaveLength(3)
    expect(inst.messages[0].role).toBe('harness')
    expect(inst.messages[0].content).toBe('banner')
    expect(inst.messages[1].role).toBe('user')
    expect(inst.messages[1].content).toBe('hello')
    expect(inst.messages[2].role).toBe('assistant')
    expect(inst.messages[2].content).toBe('hi')
    expect(inst.externalContentStatus).toBe('loaded')
    expect(inst.historyHydrated).toBe(true)
    expect(inst.messageCount).toBe(3)
  })

  it('uses only renderer-only rows from content file when engine chain is empty', async () => {
    // Engine has nothing (new session not yet saved), content file has harness rows.
    const h = makeHarness({ messages: [], messageCount: 1, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1',
      instanceId: 'main',
      schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })
    mockLoadChainHistory.mockResolvedValue([])

    await h.load()

    const inst = h.inst()
    expect(inst.messages).toHaveLength(1)
    expect(inst.messages[0].role).toBe('harness')
    expect(inst.historyHydrated).toBe(true)
  })

  it('skips engine chain when tab has no conversationId', async () => {
    // Tab without a conversationId: only content file rows, no chain load.
    const h = makeHarness(
      { messages: [], messageCount: 1, externalContentStatus: 'pending' },
      { conversationId: null, historicalSessionIds: [] },
    )
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1', instanceId: 'main', schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })

    await h.load()

    expect(mockLoadChainHistory).not.toHaveBeenCalled()
    expect(mockLoadTabContent).toHaveBeenCalledWith('tab-1')
    expect(h.inst().messages[0].content).toBe('banner')
  })

  it('falls back to content-only when engine chain fails', async () => {
    const h = makeHarness({ messages: [], messageCount: 1, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1',
      instanceId: 'main',
      schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })
    mockLoadChainHistory.mockRejectedValue(new Error('engine down'))

    await h.load()

    // No thrown error — graceful degradation to content-only
    const inst = h.inst()
    expect(inst.historyHydrated).toBe(true)
    expect(inst.externalContentStatus).toBe('loaded')
    // Content file harness row survives
    expect(inst.messages.some((m) => m.content === 'banner')).toBe(true)
  })

  it('keeps live rows that streamed in during the async load', async () => {
    const h = makeHarness({ messages: [], messageCount: 1, externalContentStatus: 'pending' })
    mockLoadChainHistory.mockResolvedValue([])
    mockLoadTabContent.mockImplementation(async () => {
      h.appendLive(liveMsg('live-1', 'streamed during load'))
      return { tabId: 'tab-1', instanceId: 'main', schemaVersion: 4, messages: [{ role: 'harness', content: 'banner', timestamp: 1 }] }
    })

    await h.load()

    const inst = h.inst()
    // harness row from content file + live tail
    expect(inst.messages).toHaveLength(2)
    expect(inst.messages[0].role).toBe('harness')
    expect(inst.messages[1].id).toBe('live-1')
  })

  it('marks error (still usable) when content file is missing and chain is empty', async () => {
    const h = makeHarness({ messages: [], messageCount: 5, externalContentStatus: 'pending' })
    mockLoadTabContent.mockResolvedValue(null)
    mockLoadChainHistory.mockResolvedValue([])

    await h.load()

    const inst = h.inst()
    // content null → externalContentStatus error, but tab is usable
    expect(inst.externalContentStatus).toBe('error')
    expect(inst.historyHydrated).toBe(true)
  })

  it('marks error when the IPC throws', async () => {
    const h = makeHarness({ messages: [], messageCount: 5, externalContentStatus: 'pending' })
    mockLoadTabContent.mockRejectedValue(new Error('disk on fire'))

    await h.load()

    expect(h.inst().externalContentStatus).toBe('error')
    expect(h.inst().historyHydrated).toBe(true)
  })

  it('does not intercept non-pending instances (engine chain path unchanged)', async () => {
    const h = makeHarness({ messages: [], messageCount: 2, historyHydrated: false })
    mockLoadChainHistory.mockResolvedValue([])

    await h.load()

    expect(mockLoadTabContent).not.toHaveBeenCalled()
    expect(mockLoadChainHistory).toHaveBeenCalled()
  })
})
