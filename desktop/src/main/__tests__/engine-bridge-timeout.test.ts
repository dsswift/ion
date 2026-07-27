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

import { EngineBridge } from '../engine-bridge'

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
