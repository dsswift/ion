/**
 * load-conversation-gate.test.ts
 *
 * The gate coalesces redundant identical desktop_load_conversation requests so a
 * flapping iOS client cannot flood the relay send path (60-120 identical
 * reloads/sec were observed, implicated in a main-thread wedge). It must:
 *   - serve the first request for a (device, tab, before) key
 *   - REPLAY the cached page for the first repeat inside the window, rather
 *     than dropping it in silence (an unanswered request stalls the client
 *     until its own 5s retry — the "Loading conversation…" spinner)
 *   - drop a repeat that has nothing to replay, and drop further repeats once
 *     the single permitted replay is used (bounded 2x amplification)
 *   - serve a repeat once the window has passed
 *   - never coalesce distinct pagination steps (different `before`) or tabs
 *   - clear a device's entries (timestamps AND cached responses) on unpair
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import {
  decideLoad,
  recordLoadResponse,
  clearLoadGateForDevice,
  COALESCE_WINDOW_MS,
  _resetLoadGate,
} from '../load-conversation-gate'
import type { RemoteEvent } from '../../protocol'

const DEV = 'device-1111'
const TAB = 'tab-aaaa'

/** A stand-in history response for the (device, tab, before) under test. */
function historyEvent(tabId: string, marker: string): RemoteEvent {
  return {
    type: 'desktop_conversation_history',
    tabId,
    messages: [{ id: marker, role: 'assistant', content: marker, timestamp: 1 }],
    hasMore: false,
    before: null,
  } as RemoteEvent
}

describe('load-conversation gate', () => {
  beforeEach(() => { _resetLoadGate() })

  it('serves the first request and replays the cached page for an immediate repeat', () => {
    const t0 = 1_000_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    // The handler answers and records what it sent.
    const page = historyEvent(TAB, 'page-1')
    recordLoadResponse(DEV, TAB, undefined, page)

    // Same key, same instant → redundant repeat, but ANSWERED from cache.
    const dup = decideLoad(DEV, TAB, undefined, t0)
    expect(dup.action).toBe('replay')
    if (dup.action === 'replay') expect(dup.event).toBe(page)
  })

  it('drops a repeat that arrives before any response was recorded', () => {
    const t0 = 1_500_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    // No recordLoadResponse yet: the first request is still in flight. Its
    // response is already addressed to this device, so the duplicate drops
    // rather than racing a second identical page onto the wire.
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('drop')
  })

  it('permits exactly one replay per window, then drops (bounded amplification)', () => {
    const t0 = 1_750_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, 'page-1'))

    expect(decideLoad(DEV, TAB, undefined, t0 + 1).action).toBe('replay')
    // Second and third duplicates in the same window get nothing: one served
    // page plus one replay is the ceiling.
    expect(decideLoad(DEV, TAB, undefined, t0 + 2).action).toBe('drop')
    expect(decideLoad(DEV, TAB, undefined, t0 + 3).action).toBe('drop')
  })

  it('serves again once the coalesce window has elapsed', () => {
    const t0 = 2_000_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, 'page-1'))
    expect(decideLoad(DEV, TAB, undefined, t0 + COALESCE_WINDOW_MS).action).toBe('serve')
  })

  it('does not replay a stale page from a previous window', () => {
    const t0 = 2_500_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, 'old-page'))
    // New window opens: the previous window's cached page is discarded, so a
    // duplicate inside the NEW window has nothing to replay (its own response
    // has not been recorded yet) and must not resurrect the old bytes.
    expect(decideLoad(DEV, TAB, undefined, t0 + COALESCE_WINDOW_MS).action).toBe('serve')
    expect(decideLoad(DEV, TAB, undefined, t0 + COALESCE_WINDOW_MS + 1).action).toBe('drop')
  })

  it('ignores a response recorded for a key with no open window', () => {
    // A response that lands after its window elapsed has no duplicate left to
    // answer; caching it would let a later request replay stale bytes.
    recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, 'orphan'))
    const t0 = 2_750_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    expect(decideLoad(DEV, TAB, undefined, t0 + 1).action).toBe('drop')
  })

  it('never coalesces distinct pagination steps (different before cursor)', () => {
    const t0 = 3_000_000
    // A genuine paginating client advances `before` each step — all distinct
    // keys, all served even back-to-back.
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    expect(decideLoad(DEV, TAB, 'msg-50', t0).action).toBe('serve')
    expect(decideLoad(DEV, TAB, 'msg-40', t0).action).toBe('serve')
  })

  it('does not coalesce across different tabs or devices', () => {
    const t0 = 4_000_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    expect(decideLoad(DEV, 'tab-bbbb', undefined, t0).action).toBe('serve')
    expect(decideLoad('device-2222', TAB, undefined, t0).action).toBe('serve')
  })

  it('models the flood: sustained identical repeats collapse to ~1 per window', () => {
    let served = 0
    let answered = 0
    const start = 5_000_000
    // 200 identical requests over 2 windows at 10ms spacing.
    for (let i = 0; i < 200; i++) {
      const v = decideLoad(DEV, TAB, undefined, start + i * 10)
      if (v.action === 'serve') {
        served++
        // A real handler answers every served request.
        recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, `page-${i}`))
      }
      if (v.action !== 'drop') answered++
    }
    // 2000ms span / 1000ms window → at most 3 served (t=0, ~1000, ~2000).
    expect(served).toBeLessThanOrEqual(3)
    // Replays are capped at one per window, so the flood is still absorbed:
    // 200 requests produce at most 6 outbound pages, not 200.
    expect(answered).toBeLessThanOrEqual(served * 2)
  })

  it('clears a device on unpair so its next request is served immediately', () => {
    const t0 = 6_000_000
    expect(decideLoad(DEV, TAB, undefined, t0).action).toBe('serve')
    recordLoadResponse(DEV, TAB, undefined, historyEvent(TAB, 'page-1'))
    expect(decideLoad(DEV, TAB, undefined, t0 + 10).action).toBe('replay')
    clearLoadGateForDevice(DEV)
    // After unpair both the timestamp and the cached response are gone → served
    // again even inside the window, with no stale page to replay afterwards.
    expect(decideLoad(DEV, TAB, undefined, t0 + 20).action).toBe('serve')
    expect(decideLoad(DEV, TAB, undefined, t0 + 21).action).toBe('drop')
  })
})
