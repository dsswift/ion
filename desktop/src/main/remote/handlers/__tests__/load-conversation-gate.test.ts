/**
 * load-conversation-gate.test.ts
 *
 * The gate drops redundant identical desktop_load_conversation requests so a
 * flapping iOS client cannot flood the relay send path (60-120 identical
 * reloads/sec were observed, implicated in a main-thread wedge). It must:
 *   - serve the first request for a (device, tab, before) key
 *   - drop repeats of the SAME key inside the coalesce window
 *   - serve a repeat once the window has passed
 *   - never coalesce distinct pagination steps (different `before`) or tabs
 *   - clear a device's entries on unpair
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { shouldServeLoad, clearLoadGateForDevice, COALESCE_WINDOW_MS, _resetLoadGate } from '../load-conversation-gate'

const DEV = 'device-1111'
const TAB = 'tab-aaaa'

describe('load-conversation gate', () => {
  beforeEach(() => { _resetLoadGate() })

  it('serves the first request and drops an immediate identical repeat', () => {
    const t0 = 1_000_000
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(true)
    // Same key, same instant → redundant repeat, dropped.
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(false)
    // Still inside the window.
    expect(shouldServeLoad(DEV, TAB, undefined, t0 + COALESCE_WINDOW_MS - 1)).toBe(false)
  })

  it('serves again once the coalesce window has elapsed', () => {
    const t0 = 2_000_000
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(true)
    expect(shouldServeLoad(DEV, TAB, undefined, t0 + COALESCE_WINDOW_MS)).toBe(true)
  })

  it('never coalesces distinct pagination steps (different before cursor)', () => {
    const t0 = 3_000_000
    // A genuine paginating client advances `before` each step — all distinct
    // keys, all served even back-to-back.
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(true)
    expect(shouldServeLoad(DEV, TAB, 'msg-50', t0)).toBe(true)
    expect(shouldServeLoad(DEV, TAB, 'msg-40', t0)).toBe(true)
  })

  it('does not coalesce across different tabs or devices', () => {
    const t0 = 4_000_000
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(true)
    expect(shouldServeLoad(DEV, 'tab-bbbb', undefined, t0)).toBe(true)
    expect(shouldServeLoad('device-2222', TAB, undefined, t0)).toBe(true)
  })

  it('models the flood: sustained identical repeats collapse to ~1 per window', () => {
    let served = 0
    const start = 5_000_000
    // 200 identical requests over 2 windows at 10ms spacing.
    for (let i = 0; i < 200; i++) {
      if (shouldServeLoad(DEV, TAB, undefined, start + i * 10)) served++
    }
    // 2000ms span / 1000ms window → at most 3 served (t=0, ~1000, ~2000).
    expect(served).toBeLessThanOrEqual(3)
  })

  it('clears a device on unpair so its next request is served immediately', () => {
    const t0 = 6_000_000
    expect(shouldServeLoad(DEV, TAB, undefined, t0)).toBe(true)
    expect(shouldServeLoad(DEV, TAB, undefined, t0 + 10)).toBe(false)
    clearLoadGateForDevice(DEV)
    // After unpair the prior timestamp is gone → served again even inside window.
    expect(shouldServeLoad(DEV, TAB, undefined, t0 + 20)).toBe(true)
  })
})
