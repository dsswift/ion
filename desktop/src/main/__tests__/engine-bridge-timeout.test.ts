import { describe, it, expect, beforeEach, vi } from 'vitest'

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
// The modules under test moved to `server/src/`, so their `'../logger'` resolves
// to `server/src/logger` -- a different module from the desktop logger mocked
// above, which therefore no longer intercepts them. Without this the real server
// logger runs inside the test worker: it writes to the log file and, where `fs`
// is mocked, fails on an export the mock does not provide.
vi.mock('@ion/server/logger', () => ({ log: vi.fn(), trace: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { EngineBridge } from '@ion/server/engine/engine-bridge'

function makeBridge(): EngineBridge {
  const bridge = new EngineBridge()
  const mockConn = {
    destroyed: false,
    write: vi.fn(),
    destroy: vi.fn(() => { mockConn.destroyed = true }),
    on: vi.fn(),
  }
  ;(bridge as any).conn = mockConn
  ;(bridge as any).connected = true
  return bridge
}

describe('EngineBridge send failure', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('fails immediately when a stopped bridge cannot accept the request', async () => {
    const bridge = makeBridge()
    const conn = (bridge as any).conn
    conn.destroyed = true
    // A stopped bridge is the one socket failure that is final: nothing will
    // reconnect, so the request must fail now rather than sit in the queue.
    ;(bridge as any).reconnectDisabled = true

    const result = await (bridge as any)._sendWithResult({
      cmd: 'send_prompt',
      key: 'tab-1',
    })

    expect(result).toEqual({ ok: false, error: 'Engine connection unavailable', unanswered: true })
    expect(bridge.requestCallbacks.size).toBe(0)
    expect(bridge.consecutiveTimeouts).toBe(0)

    vi.advanceTimersByTime(30000)
    expect(bridge.consecutiveTimeouts).toBe(0)
  })

  it('holds the request instead of failing it while a reconnect is still possible', async () => {
    const bridge = makeBridge()
    ;(bridge as any).conn.destroyed = true

    const pending = (bridge as any)._sendWithResult({ cmd: 'send_prompt', key: 'tab-1' })

    // Queued for the reconnect: the callback is still registered, so the
    // request is neither answered nor lost.
    expect(bridge.requestCallbacks.size).toBe(1)

    vi.advanceTimersByTime(30000)
    await expect(pending).resolves.toEqual({ ok: false, error: 'Request timed out', unanswered: true })
  })
})

describe('EngineBridge consecutive-timeout reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('destroys connection after 2 consecutive timeouts', async () => {
    const bridge = makeBridge()
    const conn = (bridge as any).conn

    const p1 = (bridge as any)._sendWithResult({ cmd: 'start_session' })
    vi.advanceTimersByTime(30000)
    await p1

    expect(conn.destroy).not.toHaveBeenCalled()

    const p2 = (bridge as any)._sendWithResult({ cmd: 'start_session' })
    vi.advanceTimersByTime(30000)
    await p2

    expect(conn.destroy).toHaveBeenCalledTimes(1)
  })

  it('resets counter when a response arrives', async () => {
    const bridge = makeBridge()
    const conn = (bridge as any).conn

    const p1 = (bridge as any)._sendWithResult({ cmd: 'test_cmd' })
    vi.advanceTimersByTime(30000)
    await p1

    expect((bridge as any).consecutiveTimeouts).toBe(1)

    // Simulate receiving a message (resets counter)
    ;(bridge as any)._handleMessage(JSON.stringify({
      key: 'k1',
      event: { type: 'desktop_text_chunk', text: 'hi' },
    }))

    expect((bridge as any).consecutiveTimeouts).toBe(0)

    // Next timeout should be count=1, not trigger destroy
    const p2 = (bridge as any)._sendWithResult({ cmd: 'test_cmd' })
    vi.advanceTimersByTime(30000)
    await p2

    expect(conn.destroy).not.toHaveBeenCalled()
  })

  it('resets counter when a result callback fires', async () => {
    const bridge = makeBridge()
    const conn = (bridge as any).conn

    // First request times out
    const p1 = (bridge as any)._sendWithResult({ cmd: 'test_cmd' })
    vi.advanceTimersByTime(30000)
    await p1

    expect((bridge as any).consecutiveTimeouts).toBe(1)

    // Second request gets a response before timeout
    const p2 = (bridge as any)._sendWithResult({ cmd: 'test_cmd' })
    const requestId = conn.write.mock.calls.at(-1)?.[0]
    const parsed = JSON.parse(requestId.replace('\n', ''))
    ;(bridge as any)._handleMessage(JSON.stringify({
      cmd: 'result',
      requestId: parsed.requestId,
      ok: true,
    }))
    const result = await p2

    expect(result.ok).toBe(true)
    expect((bridge as any).consecutiveTimeouts).toBe(0)
    expect(conn.destroy).not.toHaveBeenCalled()
  })
})

describe('EngineBridge connection close fails pending requests', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('pending requests resolve immediately on connection close instead of waiting 30s', async () => {
    const bridge = makeBridge()
    const conn = (bridge as any).conn

    const p = (bridge as any)._sendWithResult({ cmd: 'start_session' })

    conn.destroy.mockImplementation(() => {
      bridge._failPendingRequests('Connection closed')
    })
    conn.destroy()

    const result = await p
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Connection closed')
  })
})
