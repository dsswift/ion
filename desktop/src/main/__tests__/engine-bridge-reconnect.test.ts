/**
 * Engine bridge reconnect correctness regressions.
 *
 * Pins the fixes for:
 *  - stale socket close/error events re-arming the reconnect loop after
 *    stopAll (conn nullified before destroy; close handler checks identity)
 *  - consecutiveTimeouts carrying across connections (reset on connect)
 *  - stale request-timeout timers bumping consecutiveTimeouts after
 *    _failPendingRequests already settled them (has() guard)
 *  - reRegisterSessions generation cancellation (batch aborts when
 *    _reRegisterGeneration advances mid-flight)
 *  - scheduleReconnect timer respecting reconnectDisabled at fire time
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Socket mock ──

type CloseHandler = () => void
type ErrorHandler = (err: NodeJS.ErrnoException) => void
type ConnectHandler = () => void

let connectResults: boolean[] = []
let defaultReachable = false
let lastCreatedConn: ReturnType<typeof makeMockConn> | null = null

function makeMockConn() {
  const handlers = new Map<string, Array<(...a: unknown[]) => void>>()
  const conn = {
    on: vi.fn((ev: string, cb: (...a: unknown[]) => void) => {
      const list = handlers.get(ev) ?? []
      list.push(cb)
      handlers.set(ev, list)
      return conn
    }),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    destroyed: false,
    _handlers: handlers,
    _fireConnect() { for (const cb of handlers.get('connect') ?? []) (cb as ConnectHandler)() },
    _fireClose() { for (const cb of handlers.get('close') ?? []) (cb as CloseHandler)() },
    _fireError(err: NodeJS.ErrnoException) { for (const cb of handlers.get('error') ?? []) (cb as ErrorHandler)(err) },
  }
  return conn
}

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const reachable = connectResults.length > 0 ? connectResults.shift()! : defaultReachable
    const conn = makeMockConn()
    lastCreatedConn = conn
    queueMicrotask(() => {
      if (reachable) {
        conn._fireConnect()
      } else {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) as NodeJS.ErrnoException
        conn._fireError(err)
      }
    })
    return conn
  }),
}))
vi.mock('fs', () => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }))
vi.mock('child_process', () => ({ spawn: vi.fn(), execSync: vi.fn(() => '') }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { createConnection } from 'net'
import { EngineBridge } from '../engine-bridge'
import { scheduleReconnect } from '../engine-bridge-connection'
import { stopAll } from '../engine-bridge-lifecycle'
import { reRegisterSessions } from '../engine-bridge-start-session'

let bridge: EngineBridge

beforeEach(() => {
  vi.useFakeTimers()
  connectResults = []
  defaultReachable = false
  lastCreatedConn = null
  bridge = new EngineBridge()
})

afterEach(() => {
  bridge.reconnectDisabled = true
  if (bridge.reconnectTimer) {
    clearTimeout(bridge.reconnectTimer)
    bridge.reconnectTimer = null
  }
  vi.useRealTimers()
})

// ── stopAll: stale close does not re-arm ──

describe('stopAll settles cleanly without reconnect storm', () => {
  it('async close event from destroyed socket does not schedule a reconnect', async () => {
    connectResults = [true]
    await bridge.connect()
    const oldConn = lastCreatedConn!
    expect(bridge.connected).toBe(true)

    await stopAll(bridge)

    expect(bridge.conn).toBeNull()
    expect(bridge.connected).toBe(false)

    // Simulate the async close event from the old socket firing after
    // stopAll has already nullified bridge.conn.
    oldConn._fireClose()

    expect(bridge.reconnectTimer).toBeNull()
  })

  it('async error event from destroyed socket does not schedule a reconnect', async () => {
    connectResults = [true]
    await bridge.connect()
    const oldConn = lastCreatedConn!

    await stopAll(bridge)

    const err = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) as NodeJS.ErrnoException
    oldConn._fireError(err)

    expect(bridge.reconnectTimer).toBeNull()
  })

  it('destroys a socket that connects after teardown instead of reviving bridge state', async () => {
    // Keep the connect event pending so stopAll runs while doConnect is live.
    const pendingConn = makeMockConn()
    vi.mocked(createConnection).mockImplementationOnce(() => pendingConn as any)

    const connecting = bridge.connect()
    await Promise.resolve()
    await stopAll(bridge)

    pendingConn._fireConnect()

    await expect(connecting).rejects.toThrow('stopped during connect')
    expect(pendingConn.destroy).toHaveBeenCalledOnce()
    expect(bridge.conn).toBeNull()
    expect(bridge.connected).toBe(false)
    expect(bridge.reconnectTimer).toBeNull()
  })
})

// ── consecutiveTimeouts reset ──

describe('consecutiveTimeouts resets on new connection', () => {
  it('a timeout counter from the old connection does not carry into a new one', async () => {
    connectResults = [true]
    await bridge.connect()

    // Simulate one timeout on the first connection.
    bridge.consecutiveTimeouts = 1

    // Reconnect.
    connectResults = [true]
    bridge.connected = false
    bridge.conn = null
    await bridge.connect()

    expect(bridge.consecutiveTimeouts).toBe(0)
  })
})

// ── Stale request timeout ──

describe('stale request timeout after _failPendingRequests', () => {
  it('does not increment consecutiveTimeouts when request was already settled', async () => {
    connectResults = [true]
    await bridge.connect()

    const p = bridge._sendWithResult({ cmd: 'test_cmd' })

    // Settle all pending requests (simulating connection close).
    bridge._failPendingRequests('Connection closed')

    // The promise resolves immediately with the error.
    const result = await p
    expect(result.ok).toBe(false)

    // Now advance past the 30s timeout timer. The timer should be a
    // no-op because the callback was already invoked by _failPendingRequests.
    bridge.consecutiveTimeouts = 0
    vi.advanceTimersByTime(30000)

    expect(bridge.consecutiveTimeouts).toBe(0)
  })
})

// ── scheduleReconnect respects reconnectDisabled at fire time ──

describe('scheduleReconnect timer respects reconnectDisabled', () => {
  it('does not call connect() if reconnectDisabled is set before the timer fires', async () => {
    scheduleReconnect(bridge)
    expect(bridge.reconnectTimer).not.toBeNull()

    bridge.reconnectDisabled = true

    // Advance past the first reconnect delay (500ms).
    await vi.advanceTimersByTimeAsync(600)

    // No connect attempt was made: no new socket was created.
    expect(lastCreatedConn).toBeNull()
  })
})

// ── Deferred interrupt survives reconnect ──

describe('interrupt issued while the socket is down', () => {
  it('records the abort instead of dropping it, then delivers it on reconnect', async () => {
    connectResults = [true]
    await bridge.connect()
    const firstConn = lastCreatedConn!

    // Socket dies; the operator hits interrupt before reconnect completes.
    firstConn.destroyed = true
    bridge.sendAbort('tab-1')
    expect(bridge.pendingAborts.has('tab-1')).toBe(true)
    expect(firstConn.write).not.toHaveBeenCalled()

    const delivered: string[] = []
    bridge.on('abort-delivered', (key: string) => delivered.push(key))

    // Reconnect: the deferred abort goes out and the session is retired.
    bridge.activeSessions.set('tab-1', { config: {} as never, conversationId: 'conv-1' } as never)
    connectResults = [true]
    bridge.connected = false
    bridge.conn = null
    bridge.reconnectAttempts = 1
    await bridge.connect()

    const sent = (lastCreatedConn!.write.mock.calls as Array<[string]>).map(([line]) => JSON.parse(line))
    expect(sent.some((m) => m.cmd === 'abort' && m.key === 'tab-1')).toBe(true)
    expect(sent.some((m) => m.cmd === 'abort_agent' && m.key === 'tab-1' && m.subtree === true)).toBe(true)
    expect(bridge.pendingAborts.size).toBe(0)
    expect(bridge.activeSessions.has('tab-1')).toBe(false)
    expect(delivered).toEqual(['tab-1'])
  })

  it('coalesces repeated interrupts on the same key into one pending abort', async () => {
    connectResults = [true]
    await bridge.connect()
    lastCreatedConn!.destroyed = true

    bridge.sendAbort('tab-1')
    bridge.sendAbort('tab-1')
    bridge.sendAbort('tab-1')

    expect([...bridge.pendingAborts.keys()]).toEqual(['tab-1'])
  })

  it('retains a deferred abort when either reconnect write fails', () => {
    bridge._reRegisterGeneration = 2
    bridge.pendingAborts.set('tab-1', 1)
    bridge.activeSessions.set('tab-1', { config: {} as never, conversationId: 'conv-1' } as never)
    const delivered: string[] = []
    bridge.on('abort-delivered', (key: string) => delivered.push(key))
    vi.spyOn(bridge, '_send').mockReturnValue(false)

    bridge.flushPendingAborts()

    expect(bridge.pendingAborts.get('tab-1')).toBe(1)
    expect(bridge.activeSessions.has('tab-1')).toBe(true)
    expect(delivered).toEqual([])
  })

  it('delivers a retained abort only on a newer connection generation', () => {
    bridge._reRegisterGeneration = 2
    bridge.pendingAborts.set('tab-1', 2)
    const send = vi.spyOn(bridge, '_send').mockReturnValue(true)

    bridge.flushPendingAborts()
    expect(send).not.toHaveBeenCalled()
    expect(bridge.pendingAborts.has('tab-1')).toBe(true)

    bridge._reRegisterGeneration = 3
    bridge.flushPendingAborts()
    expect(bridge.pendingAborts.has('tab-1')).toBe(false)
  })

  it('does not re-register a session whose interrupt is still pending', () => {
    bridge.activeSessions.set('tab-aborted', { config: {} as never, conversationId: 'conv-a' } as never)
    bridge.activeSessions.set('tab-live', { config: {} as never, conversationId: 'conv-b' } as never)
    bridge.pendingAborts.set('tab-aborted', bridge._reRegisterGeneration)

    const sendWithResult = vi.spyOn(bridge, '_sendWithResult').mockResolvedValue({ ok: true })
    reRegisterSessions(bridge)

    const keys = sendWithResult.mock.calls.map(([msg]) => (msg as { key: string }).key)
    expect(keys).toEqual(['tab-live'])
  })
})

// ── reRegisterSessions generation cancellation ──

describe('reRegisterSessions generation cancellation', () => {
  it('cancels in-flight re-registration when _reRegisterGeneration advances', async () => {
    connectResults = [true]
    await bridge.connect()

    for (let i = 0; i < 8; i++) {
      bridge.activeSessions.set(`key-${i}`, { config: {} as any })
    }

    const sentKeys: string[] = []
    // Deferred promises let us control exactly when each batch settles,
    // so we can advance the generation between batch 1 completing and
    // batch 2 starting.
    let resolvers: Array<(v: { ok: boolean }) => void> = []
    bridge._sendWithResult = vi.fn((msg: any) => {
      sentKeys.push(msg.key)
      return new Promise<{ ok: boolean }>(resolve => { resolvers.push(resolve) })
    })

    const gen = bridge._reRegisterGeneration
    reRegisterSessions(bridge)

    // Flush microtasks — the IIFE runs to `await Promise.all(batch1)`,
    // creating 5 deferred promises.
    await vi.advanceTimersByTimeAsync(0)
    expect(sentKeys.length).toBe(5)
    expect(resolvers.length).toBe(5)

    // Advance generation BEFORE resolving batch 1.
    bridge._reRegisterGeneration = gen + 1

    // Resolve batch 1 and flush — the for-loop resumes, sees generation
    // mismatch, and returns without creating batch 2.
    for (const r of resolvers) r({ ok: true })
    await vi.advanceTimersByTimeAsync(0)

    expect(sentKeys.length).toBe(5)
  })
})

// ── _reRegisterGeneration increments on connect ──

describe('connection generation tracking', () => {
  it('increments _reRegisterGeneration on each successful connect', async () => {
    const gen0 = bridge._reRegisterGeneration
    connectResults = [true]
    await bridge.connect()
    expect(bridge._reRegisterGeneration).toBe(gen0 + 1)

    // Reconnect.
    bridge.connected = false
    bridge.conn = null
    connectResults = [true]
    await bridge.connect()
    expect(bridge._reRegisterGeneration).toBe(gen0 + 2)
  })
})
