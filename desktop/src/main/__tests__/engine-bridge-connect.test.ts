/**
 * EngineBridge connect() outage behavior.
 *
 * Regression pins for the engine-down startup stall: 30 restoring tabs each
 * called connect() serially against a dead socket, and every call burned the
 * full retry ladder (500+1000+2000+4000 = 7.5s) before throwing — with NO
 * background reconnect armed afterward. These tests fail on that code:
 *
 *  - a failed ladder left `reconnectTimer` null (nothing retrying), and
 *  - a second connect() during the outage ran the full ladder again
 *    (5 socket attempts) instead of failing fast after one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Socket-attempt control: per-attempt queue, then default (unreachable).
let connectResults: boolean[] = []
let defaultReachable = false
let connectAttempts = 0

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    connectAttempts++
    const reachable = connectResults.length > 0 ? connectResults.shift()! : defaultReachable
    const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    const conn = {
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        const list = handlers.get(ev) ?? []
        list.push(cb)
        handlers.set(ev, list)
        return conn
      },
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    }
    // Emit async (microtask) so the bridge has registered its handlers first.
    // Microtasks flush on await even under fake timers.
    queueMicrotask(() => {
      if (reachable) {
        for (const cb of handlers.get('connect') ?? []) cb()
      } else {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        for (const cb of handlers.get('error') ?? []) cb(err)
      }
    })
    return conn
  }),
}))
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
}))
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => ''),
}))
vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { EngineBridge } from '../engine-bridge'

let bridge: EngineBridge

beforeEach(() => {
  vi.useFakeTimers()
  connectResults = []
  defaultReachable = false
  connectAttempts = 0
  bridge = new EngineBridge()
})

afterEach(() => {
  // Disarm any background reconnect timer so it can't fire across tests.
  bridge.reconnectDisabled = true
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }
  vi.useRealTimers()
})

describe('EngineBridge connect() during an engine outage', () => {
  it('an exhausted retry ladder arms the background reconnect loop and records the outage', async () => {
    const p = bridge.connect()
    p.catch(() => {}) // silent-ok: rejection asserted below; guard unhandled-rejection

    // Ladder: immediate attempt + 500/1000/2000/4000 delays.
    await vi.advanceTimersByTimeAsync(7500)
    await expect(p).rejects.toThrow(/not reachable/)

    expect(connectAttempts).toBe(5)
    // Old code: reconnectTimer stayed null after a failed foreground connect —
    // nothing kept retrying in the background.
    expect(bridge.reconnectTimer).not.toBeNull()
    expect((bridge as unknown as { lastLadderFailureAt: number }).lastLadderFailureAt).toBeGreaterThan(0)
  })

  it('fails fast (one attempt, no ladder) while a recent outage is known', async () => {
    ;(bridge as unknown as { lastLadderFailureAt: number }).lastLadderFailureAt = Date.now()

    const p = bridge.connect()
    p.catch(() => {}) // silent-ok: rejection asserted below; guard unhandled-rejection
    await expect(p).rejects.toThrow(/reconnect in progress/)

    // Old code: 5 attempts (full ladder) per caller — 30 restoring tabs paid
    // 7.5s each. New code: one immediate attempt, then fast-fail.
    expect(connectAttempts).toBe(1)
    expect(bridge.reconnectTimer).not.toBeNull()
  })

  it('runs the full ladder again once the fast-fail window has expired', async () => {
    ;(bridge as unknown as { lastLadderFailureAt: number }).lastLadderFailureAt = Date.now() - 31000

    const p = bridge.connect()
    p.catch(() => {}) // silent-ok: rejection asserted below; guard unhandled-rejection
    await vi.advanceTimersByTimeAsync(7500)
    await expect(p).rejects.toThrow(/not reachable/)

    // Stale outage marker → this caller re-runs the ladder (the daemon may be
    // mid-start; the ladder covers the kickstart→bind window).
    expect(connectAttempts).toBe(5)
  })

  it('a successful connect clears the outage marker', async () => {
    ;(bridge as unknown as { lastLadderFailureAt: number }).lastLadderFailureAt = Date.now()
    connectResults = [true]

    await bridge.connect()

    expect(bridge.connected).toBe(true)
    expect((bridge as unknown as { lastLadderFailureAt: number }).lastLadderFailureAt).toBe(0)
  })
})
