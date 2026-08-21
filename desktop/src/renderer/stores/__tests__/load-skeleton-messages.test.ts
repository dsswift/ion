/**
 * loadSkeletonMessages — the lazy history hydration path, and the
 * historyHydrated marker that gates it.
 *
 * Regression pin for the Studio window last-turn-only bug: live streamed events append
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

  it('hydrates explicit unhydrated state even when cached count is stale at zero', async () => {
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'persisted prompt' },
      { role: 'assistant', content: 'persisted answer' },
    ])
    // Real historical files can survive while a prior bad persistence cycle
    // wrote messageCount: 0. Explicit historyHydrated:false is authoritative;
    // cached count must not suppress disk hydration.
    const h = makeHarness({ messages: [], messageCount: 0, historyHydrated: false })

    await h.load()

    expect(mockLoadChainHistory).toHaveBeenCalledWith(['conv-old', 'conv-1'])
    expect(h.inst().messages.map((m) => m.content)).toEqual(['persisted prompt', 'persisted answer'])
    expect(h.inst().historyHydrated).toBe(true)

    mockLoadChainHistory.mockClear()
    await h.load()
    expect(mockLoadChainHistory).not.toHaveBeenCalled()
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

  it('keeps a fresh prompt that precedes an empty history load', async () => {
    // The auto-fix path inserts its machine prompt before lazy hydration. The
    // engine can answer this load before it persists that prompt.
    const h = makeHarness({
      messages: [{ id: 'request-1', role: 'user', content: 'resolve this conflict', timestamp: 1 }],
      messageCount: 1,
      historyHydrated: false,
    })
    mockLoadChainHistory.mockImplementation(async () => {
      h.appendLive(liveMsg('mid', 'streamed during load'))
      return []
    })
    await h.load()
    expect(h.inst().messages.map((m) => m.content)).toEqual(['resolve this conflict', 'streamed during load'])
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

  it('load failure keeps live messages and marks for retry', async () => {
    mockLoadChainHistory.mockRejectedValue(new Error('ipc down'))
    const h = makeHarness({ messages: [liveMsg('live', 'live only')], messageCount: 5, historyHydrated: false })
    await h.load()
    expect(h.inst().messages.map((m) => m.content)).toEqual(['live only'])
    // Live messages present → commitInstance's lockstep keeps the count in
    // sync with what the pane can actually render.
    expect(h.inst().messageCount).toBe(1)
    expect(h.inst().historyHydrated).toBe(true)
    // No retry loop on tab switch...
    expect(needsHistoryHydration(h.inst())).toBe(false)
    // ...but the pane is marked so the engine-reconnect path retries it.
    expect(h.inst().historyHydrationFailed).toBe(true)
  })

  it('load failure on an EMPTY pane preserves the persisted count (outage regression)', async () => {
    // The 30-tab outage scenario: skeleton pane, nothing streamed, engine
    // down. The old catch set messageCount to the live length — ZERO — which
    // lied to blank-tab detection and the iOS wire, and permanently broke the
    // needsHistoryHydration gate (count 0 → "nothing to load") so the tab
    // could never hydrate even after re-arming.
    mockLoadChainHistory.mockRejectedValue(new Error('engine down'))
    const h = makeHarness({ messages: [], messageCount: 5, historyHydrated: false })
    await h.load()
    expect(h.inst().messages).toHaveLength(0)
    expect(h.inst().messageCount).toBe(5)
    expect(h.inst().historyHydrationFailed).toBe(true)
    // The preserved count is what lets the re-armed pane pass the hydration
    // gate on the next activation.
    expect(needsHistoryHydration({ ...h.inst(), historyHydrated: false, historyHydrationFailed: false })).toBe(true)
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
    // Explicit false is authoritative even when cached messageCount is stale at
    // zero; loader decides whether durable history is truly empty.
    expect(needsHistoryHydration({ ...base, historyHydrated: false, messages: [], messageCount: 0 })).toBe(true)
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
    // But the engine rows are missing, so the pane is marked for retry when
    // the engine reconnects — 'loaded' must not masquerade as complete.
    expect(inst.historyHydrationFailed).toBe(true)
  })

  it('keeps a fresh prompt that precedes an externalized history load', async () => {
    const h = makeHarness({
      messages: [{ id: 'request-1', role: 'user', content: 'resolve this conflict', timestamp: 2 }],
      messageCount: 1,
      externalContentStatus: 'pending',
    })
    mockLoadChainHistory.mockResolvedValue([])
    mockLoadTabContent.mockImplementation(async () => {
      h.appendLive(liveMsg('live-1', 'streamed during load'))
      return { tabId: 'tab-1', instanceId: 'main', schemaVersion: 4, messages: [{ role: 'harness', content: 'banner', timestamp: 1 }] }
    })

    await h.load()

    const inst = h.inst()
    expect(inst.messages.map((m) => m.content)).toEqual(['banner', 'resolve this conflict', 'streamed during load'])
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

// ─── Engine-reconnect rehydration ─────────────────────────────────────────────
//
// Regression pin for the engine-outage stranding: a history load that failed
// while the engine was down marked the pane hydrated and NOTHING ever retried
// it — the tab stayed empty for the rest of the app session even after the
// engine came back. rehydrateFailedHistory (fired on the bridge 'reconnected'
// broadcast) re-arms exactly the failed panes.

describe('rehydrateFailedHistory', () => {
  const mockLoadTabContent = vi.fn()

  beforeEach(() => {
    mockLoadTabContent.mockReset()
    mockLoadChainHistory.mockReset()
    ;(globalThis as { window?: { ion?: object } }).window!.ion = {
      loadChainHistory: mockLoadChainHistory,
      loadTabContent: mockLoadTabContent,
    } as never
  })

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('re-arms a failed engine-chain pane and reloads the active tab', async () => {
    mockLoadChainHistory.mockRejectedValueOnce(new Error('engine down'))
    const h = makeHarness({ messages: [], messageCount: 3, historyHydrated: false })
    await h.load()
    expect(h.inst().historyHydrationFailed).toBe(true)
    expect(h.inst().messages).toHaveLength(0)

    // Engine is back: the retry loads the real history.
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'recovered prompt' },
      { role: 'assistant', content: 'recovered answer' },
    ])
    h.rehydrate()
    await flush()

    expect(h.inst().messages.map((m) => m.content)).toEqual(['recovered prompt', 'recovered answer'])
    expect(h.inst().historyHydrated).toBe(true)
    expect(h.inst().historyHydrationFailed).toBe(false)
  })

  it('is a no-op when no pane failed', async () => {
    mockLoadChainHistory.mockResolvedValue([{ role: 'user', content: 'hi' }])
    const h = makeHarness({ messages: [], messageCount: 1, historyHydrated: false })
    await h.load()
    mockLoadChainHistory.mockClear()

    h.rehydrate()
    await flush()

    expect(mockLoadChainHistory).not.toHaveBeenCalled()
    expect(h.inst().historyHydrated).toBe(true)
  })

  it('re-enters the external path for a chain-failed external pane (completes the merge)', async () => {
    // First pass: content file loads, engine chain fails → 'loaded' but
    // marked for retry (engine rows missing).
    mockLoadTabContent.mockResolvedValue({
      tabId: 'tab-1', instanceId: 'main', schemaVersion: 4,
      messages: [{ role: 'harness', content: 'banner', timestamp: 1 }],
    })
    mockLoadChainHistory.mockRejectedValueOnce(new Error('engine down'))
    const h = makeHarness({ messages: [], messageCount: 2, externalContentStatus: 'pending' })
    await h.load()
    expect(h.inst().externalContentStatus).toBe('loaded')
    expect(h.inst().historyHydrationFailed).toBe(true)
    expect(h.inst().messages.map((m) => m.content)).toEqual(['banner'])

    // Engine is back: the full content-file + engine-chain merge reruns.
    mockLoadChainHistory.mockResolvedValue([
      { role: 'user', content: 'hello', timestamp: 2 },
      { role: 'assistant', content: 'hi', timestamp: 3 },
    ])
    h.rehydrate()
    await flush()

    const inst = h.inst()
    expect(inst.messages.map((m) => m.content)).toEqual(['banner', 'hello', 'hi'])
    expect(inst.externalContentStatus).toBe('loaded')
    expect(inst.historyHydrationFailed).toBe(false)
    expect(inst.historyHydrated).toBe(true)
  })
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
  const mockLoadTabContent = vi.fn()

  beforeEach(() => {
    mockLoadTabContent.mockReset()
    mockLoadChainHistory.mockReset()
    ;(globalThis as { window?: { ion?: object } }).window!.ion = {
      loadChainHistory: mockLoadChainHistory,
      loadTabContent: mockLoadTabContent,
    } as never
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
