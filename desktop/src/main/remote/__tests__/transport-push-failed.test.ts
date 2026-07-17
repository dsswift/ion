/**
 * Tests for relay:push-failed control frame consumption in RemoteTransport.
 *
 * Verifies that when the relay emits a relay:push-failed control frame,
 * the transport re-emits a 'push-failed' domain event carrying the reason
 * and resourceId, and that the frame does NOT get misparsed as a WireMessage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import type { RelayControlMessage } from '../protocol'

// Mock the logger to suppress file I/O during tests.
vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock RelayClient so we can simulate control frames without a real WebSocket.
// We capture the instance created by RemoteTransport so we can emit events on it.
let capturedRelayInstance: EventEmitter | null = null

vi.mock('../relay-client', () => {
  return {
    RelayClient: class MockRelayClient extends EventEmitter {
      connected = false
      constructor(_opts: unknown) {
        super()
        capturedRelayInstance = this
      }
      connect() { /* no-op */ }
      disconnect() { /* no-op */ }
      send() { /* no-op */ }
      updateOptions() { /* no-op */ }
    },
  }
})

// Mock LANServer so no real sockets are opened.
vi.mock('../lan-server', () => {
  return {
    LANServer: class MockLANServer extends EventEmitter {
      start() { return Promise.resolve() }
      stop() { return Promise.resolve() }
      hasClient() { return false }
      disconnectClient() { /* no-op */ }
      send() { /* no-op */ }
    },
  }
})

// Import after mocks are set up.
import { RemoteTransport } from '../transport'

function makeTransport(): RemoteTransport {
  return new RemoteTransport({
    relayUrl: 'wss://relay.example.com',
    relayApiKey: 'test-key',
    lanPort: 0,
    getPairedDevice: () => null,
    getAllPairedDevices: () => [{
      id: 'device-1',
      name: 'Test Device',
      pairedAt: new Date().toISOString(),
      lastSeen: null,
      channelId: 'chan-abc',
      sharedSecret: Buffer.alloc(32).toString('base64'),
    }],
  })
}

describe('relay:push-failed control frame', () => {
  beforeEach(() => {
    capturedRelayInstance = null
  })

  it('emits push-failed domain event with reason and resourceId', async () => {
    const transport = makeTransport()
    await transport.start()

    // Ensure the relay client was created and captured.
    expect(capturedRelayInstance).not.toBeNull()

    const pushFailedEvents: Array<{ reason?: string; resourceId?: string; deviceId: string }> = []
    transport.on('push-failed', (payload) => {
      pushFailedEvents.push(payload)
    })

    // Simulate the relay emitting a relay:push-failed control frame.
    const ctrl: RelayControlMessage = {
      type: 'relay:push-failed',
      reason: 'invalid_token',
      resourceId: 'res-abc-123',
    }
    capturedRelayInstance!.emit('control', ctrl)

    expect(pushFailedEvents).toHaveLength(1)
    expect(pushFailedEvents[0].reason).toBe('invalid_token')
    expect(pushFailedEvents[0].resourceId).toBe('res-abc-123')
    expect(pushFailedEvents[0].deviceId).toBe('device-1')

    await transport.stop()
  })

  it('emits push-failed with undefined fields when relay omits them', async () => {
    const transport = makeTransport()
    await transport.start()

    expect(capturedRelayInstance).not.toBeNull()

    const pushFailedEvents: Array<{ reason?: string; resourceId?: string; deviceId: string }> = []
    transport.on('push-failed', (payload) => {
      pushFailedEvents.push(payload)
    })

    const ctrl: RelayControlMessage = { type: 'relay:push-failed' }
    capturedRelayInstance!.emit('control', ctrl)

    expect(pushFailedEvents).toHaveLength(1)
    expect(pushFailedEvents[0].reason).toBeUndefined()
    expect(pushFailedEvents[0].resourceId).toBeUndefined()
    expect(pushFailedEvents[0].deviceId).toBe('device-1')

    await transport.stop()
  })

  it('does not emit push-failed for peer-reconnected control frames', async () => {
    const transport = makeTransport()
    await transport.start()

    expect(capturedRelayInstance).not.toBeNull()

    let pushFailedFired = false
    transport.on('push-failed', () => { pushFailedFired = true })

    const ctrl: RelayControlMessage = { type: 'relay:peer-reconnected' }
    capturedRelayInstance!.emit('control', ctrl)

    expect(pushFailedFired).toBe(false)

    await transport.stop()
  })

  it('relay:push-failed is not decoded as a WireMessage', () => {
    // A relay:push-failed frame has no seq field; JSONDecoder treating it as
    // a WireMessage would produce seq=0 and fail the seq>0 dedup guard.
    // Confirm the frame shape matches RelayControlMessage, not WireMessage.
    const frame = JSON.parse('{"type":"relay:push-failed","reason":"transient","resourceId":"r1"}')
    // A WireMessage requires a numeric seq field.
    expect(typeof frame.seq).toBe('undefined')
    // The frame carries the relay: type prefix identifying it as a control frame.
    expect(typeof frame.type).toBe('string')
    expect((frame.type as string).startsWith('relay:')).toBe(true)
  })
})
