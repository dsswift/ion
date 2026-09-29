/**
 * Tests for RelayClient connection-generation guards and intentional-close
 * safety. These tests verify that stale callbacks from superseded WebSocket
 * connections never mutate the state of the current connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1
  readyState = MockWebSocket.OPEN
  headers: Record<string, string> = {}

  constructor(_url: string, opts?: { headers?: Record<string, string> }) {
    super()
    if (opts?.headers) this.headers = opts.headers
  }

  close(): void {
    this.readyState = 3
  }

  send(_data: string): void { /* noop */ }

  fireOpen(): void {
    this.emit('open')
  }

  fireClose(code: number, reason = ''): void {
    this.emit('close', code, Buffer.from(reason))
  }

  fireMessage(data: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(data)))
  }

  fireError(msg: string): void {
    this.emit('error', new Error(msg))
  }

  fireUnexpectedResponse(statusCode: number): void {
    this.emit('unexpected-response', { destroy: vi.fn() }, { statusCode, resume: vi.fn() })
  }
}

// Track all created instances for test assertions.
let mockInstances: MockWebSocket[] = []

vi.mock('ws', () => {
  return {
    default: class extends MockWebSocket {
      constructor(url: string, opts?: { headers?: Record<string, string> }) {
        super(url, opts)
        mockInstances.push(this)
      }
    },
    __esModule: true,
  }
})

vi.mock('../../logger', () => ({
  log: vi.fn(),
  error: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let RelayClient: typeof import('../relay-client').RelayClient

beforeEach(async () => {
  mockInstances = []
  vi.useFakeTimers()
  const mod = await import('../relay-client')
  RelayClient = mod.RelayClient
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('connection generation guards', () => {
  it('stale close callback does not null current socket or emit disconnected', () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()
    const ws1 = mockInstances[0]
    ws1.fireOpen()
    expect(client.connected).toBe(true)

    // Second connect supersedes the first.
    client.connect()
    const ws2 = mockInstances[1]
    ws2.fireOpen()
    expect(client.connected).toBe(true)

    const disconnectSpy = vi.fn()
    client.on('disconnected', disconnectSpy)

    // Old socket fires close -- must be ignored.
    ws1.fireClose(1006, 'abnormal')
    expect(client.connected).toBe(true)
    expect(disconnectSpy).not.toHaveBeenCalled()

    client.disconnect()
  })

  it('stale open callback does not set connected on a disconnected client', () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()
    const ws1 = mockInstances[0]

    client.disconnect()
    expect(client.connected).toBe(false)

    // Old socket fires open after disconnect -- must be ignored.
    ws1.fireOpen()
    expect(client.connected).toBe(false)
  })

  it('stale message callback does not emit on current generation', () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()
    const ws1 = mockInstances[0]
    ws1.fireOpen()

    client.connect()
    const ws2 = mockInstances[1]
    ws2.fireOpen()

    const messageSpy = vi.fn()
    client.on('message', messageSpy)

    // Message from old socket -- must be ignored.
    ws1.fireMessage({ type: 'stale_msg' })
    expect(messageSpy).not.toHaveBeenCalled()

    // Message from current socket -- must arrive.
    ws2.fireMessage({ type: 'fresh_msg' })
    expect(messageSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'fresh_msg' }))

    client.disconnect()
  })

  it('stale close does not schedule reconnect', () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()
    const ws1 = mockInstances[0]
    ws1.fireOpen()

    // Reconnect (simulated: connect again).
    client.connect()
    const ws2 = mockInstances[1]
    ws2.fireOpen()

    const reconnectSpy = vi.spyOn(client as any, '_scheduleReconnect')

    // Stale close from ws1 must not trigger reconnect.
    ws1.fireClose(1006)
    expect(reconnectSpy).not.toHaveBeenCalled()

    client.disconnect()
    reconnectSpy.mockRestore()
  })
})

describe('post-credential intentional-close guard', () => {
  it('abandons connect when disconnect() called during getCredential', async () => {
    let resolveCredential!: (token: string) => void
    const getCredential = vi.fn().mockImplementation(() =>
      new Promise<string>((r) => { resolveCredential = r })
    )

    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: '',
      channelId: 'ch1',
      getCredential,
    })

    client.connect()

    // disconnect() while credential is pending.
    client.disconnect()

    // Resolve the credential -- _doConnect should bail, no WebSocket created.
    resolveCredential('late-token')
    await vi.advanceTimersByTimeAsync(10)

    expect(mockInstances).toHaveLength(0)
    expect(client.connected).toBe(false)
  })

  it('abandons connect when a newer _doConnect races the credential', async () => {
    let resolveFirst!: (token: string) => void
    let callCount = 0

    const getCredential = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) {
        return new Promise<string>((r) => { resolveFirst = r })
      }
      return Promise.resolve('second-token')
    })

    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: '',
      channelId: 'ch1',
      getCredential,
    })

    // First connect -- credential hangs.
    client.connect()

    // Second connect -- credential resolves immediately.
    client.connect()
    await vi.advanceTimersByTimeAsync(10)

    // Second connect should have created one WebSocket.
    expect(mockInstances).toHaveLength(1)

    // Now resolve the first credential -- should bail (generation stale).
    resolveFirst('first-token')
    await vi.advanceTimersByTimeAsync(10)

    // Still only one WebSocket.
    expect(mockInstances).toHaveLength(1)

    client.disconnect()
  })
})

describe('disconnect() bumps generation', () => {
  it('increments generation so pending callbacks are invalidated', () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    const genBefore = (client as any).generation

    client.connect()
    const genAfterConnect = (client as any).generation
    expect(genAfterConnect).toBeGreaterThan(genBefore)

    client.disconnect()
    const genAfterDisconnect = (client as any).generation
    expect(genAfterDisconnect).toBeGreaterThan(genAfterConnect)
  })
})

describe('upgrade credential rejections', () => {
  it('requests a forced refresh after an HTTP 401 upgrade rejection', () => {
    const onCredentialRejected = vi.fn()
    const client = new RelayClient({
      relayUrl: 'ws://relay.test', apiKey: 'key', channelId: 'ch1', onCredentialRejected,
    })

    client.connect()
    const ws = mockInstances[0]
    ws.fireUnexpectedResponse(401)
    ws.fireClose(1006, 'abnormal')

    expect(onCredentialRejected).toHaveBeenCalledOnce()
    client.disconnect()
  })

  it('latches an identity mismatch after an HTTP 403 upgrade rejection', () => {
    const client = new RelayClient({ relayUrl: 'ws://relay.test', apiKey: 'key', channelId: 'ch1' })
    const failed = vi.fn()
    client.on('failed', failed)

    client.connect()
    const ws = mockInstances[0]
    ws.fireUnexpectedResponse(403)
    ws.fireClose(1006, 'abnormal')

    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ reason: 'identity_mismatch' }))
    client.disconnect()
  })

  it('backs off after a transient HTTP upgrade rejection', async () => {
    const client = new RelayClient({ relayUrl: 'ws://relay.test', apiKey: 'key', channelId: 'ch1' })

    client.connect()
    mockInstances[0].fireUnexpectedResponse(404)

    expect(client.connected).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockInstances.length).toBeGreaterThan(1)
    client.disconnect()
  })
  it('keeps a bare 1006 transient without requesting a credential refresh', () => {
    const onCredentialRejected = vi.fn()
    const client = new RelayClient({
      relayUrl: 'ws://relay.test', apiKey: 'key', channelId: 'ch1', onCredentialRejected,
    })

    client.connect()
    mockInstances[0].fireClose(1006, 'abnormal')

    expect(onCredentialRejected).not.toHaveBeenCalled()
    client.disconnect()
  })
})

describe('token-expired escalation', () => {
  it('escalates to permanent after consecutive 4401 closes', async () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    const failedSpy = vi.fn()
    client.on('failed', failedSpy)

    client.connect()

    for (let i = 0; i < 5; i++) {
      const ws = mockInstances[mockInstances.length - 1]
      ws.fireOpen()
      expect((client as any).tokenExpiredCount).toBe(i)
      ws.fireClose(4401, 'token expired')

      if (i < 4) {
        expect(failedSpy).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(60000)
      }
    }

    expect(failedSpy).toHaveBeenCalledTimes(1)
    expect(failedSpy).toHaveBeenCalledWith(
      expect.objectContaining({ class: 'permanent', reason: 'token_stale' })
    )

    client.disconnect()
  })

  it('resets token-expired count on non-4401 close', async () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()

    // Three 4401 closes.
    for (let i = 0; i < 3; i++) {
      const ws = mockInstances[mockInstances.length - 1]
      ws.fireOpen()
      ws.fireClose(4401, 'token expired')
      await vi.advanceTimersByTimeAsync(60000)
    }

    expect((client as any).tokenExpiredCount).toBe(3)

    // Non-4401 close resets counter.
    const ws = mockInstances[mockInstances.length - 1]
    ws.fireOpen()
    ws.fireClose(1006, 'abnormal')
    expect((client as any).tokenExpiredCount).toBe(0)

    client.disconnect()
  })

  it('retry() clears token-expired escalation', async () => {
    const client = new RelayClient({
      relayUrl: 'ws://relay.test',
      apiKey: 'key',
      channelId: 'ch1',
    })

    client.connect()

    // Drive to permanent failure via 5 consecutive 4401s.
    for (let i = 0; i < 5; i++) {
      const ws = mockInstances[mockInstances.length - 1]
      ws.fireOpen()
      ws.fireClose(4401, 'token expired')
      if (i < 4) await vi.advanceTimersByTimeAsync(60000)
    }

    expect((client as any).permanentFailure).toBeTruthy()
    expect((client as any).tokenExpiredCount).toBe(5)

    client.retry()
    expect((client as any).permanentFailure).toBeNull()
    expect((client as any).tokenExpiredCount).toBe(0)

    client.disconnect()
  })
})
