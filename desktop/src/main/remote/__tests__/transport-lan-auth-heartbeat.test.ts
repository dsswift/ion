/**
 * transport-lan-auth-heartbeat.test.ts
 *
 * Regression coverage for the resume-probe LAN flap (the create-tab
 * "not connected" incident):
 *
 *  1. handleLanAuthResponse invokes ctx.onAuthenticated AFTER recomputeState,
 *     so the transport can push an immediate proof-of-life heartbeat over the
 *     just-authenticated LAN socket. Without it, the first heartbeat lags up
 *     to a full 15s interval behind auth, and iOS's post-resume liveness
 *     probe (which waits a bounded window for a LAN-delivered frame) tears
 *     down a perfectly healthy socket.
 *  2. RemoteTransport wires onAuthenticated to a real heartbeat send: a LAN
 *     auth completion delivers a desktop_heartbeat frame to that device
 *     immediately, without waiting for the interval timer.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../transport-compression', () => ({
  compressPayload: (s: string) => Buffer.from(s, 'utf-8'),
  decompressPayload: (b: Buffer) => b.toString('utf-8'),
}))
vi.mock('../crypto', () => ({
  encrypt: (wire: Buffer) => ({ nonce: 'n', ciphertext: Buffer.from(wire).toString('base64') }),
  decrypt: (_nonce: string, ciphertext: string) => Buffer.from(ciphertext, 'base64'),
  createAuthNonce: () => 'test-nonce',
  verifyAuthProof: () => true,
}))
vi.mock('../crypto-core', () => ({
  encrypt: (wire: Buffer) => ({ nonce: 'n', ciphertext: Buffer.from(wire).toString('base64') }),
}))

interface MockRelay extends EventEmitter {
  connected: boolean
  sent: any[]
}
interface MockLan extends EventEmitter {
  hasClientResult: boolean
  sent: Array<{ frame: any; connectionId: string }>
}
let relayInstances: MockRelay[] = []
let lanInstances: MockLan[] = []

vi.mock('../relay-client', () => ({
  RelayClient: class extends EventEmitter {
    connected = false
    sent: any[] = []
    constructor(_opts: unknown) {
      super()
      relayInstances.push(this as unknown as MockRelay)
    }
    connect(): void { /* no-op */ }
    disconnect(): void { this.connected = false }
    send(frame: any): void { this.sent.push(frame) }
    updateOptions(): void { /* no-op */ }
  },
}))

vi.mock('../lan-server', () => ({
  LANServer: class extends EventEmitter {
    hasClientResult = true
    sent: Array<{ frame: any; connectionId: string }> = []
    constructor(_opts: unknown) {
      super()
      lanInstances.push(this as unknown as MockLan)
    }
    start(): Promise<void> { return Promise.resolve() }
    stop(): Promise<void> { return Promise.resolve() }
    hasClient(): boolean { return this.hasClientResult }
    send(frame: any, connectionId: string): void { this.sent.push({ frame, connectionId }) }
    sendRaw(): void { /* no-op */ }
    getClientIp(): string { return '10.0.0.2' }
    recordAuthFailure(): void { /* no-op */ }
    recordAuthSuccess(): void { /* no-op */ }
    rekeyClient(): void { /* no-op */ }
    disconnectClient(): void { /* no-op */ }
  },
}))

import { RemoteTransport } from '../transport'
import { handleLanAuthResponse, type LanAuthCtx } from '../transport-lan-auth'

const DEVICE = {
  id: 'device-1',
  name: 'Test device-1',
  pairedAt: new Date().toISOString(),
  lastSeen: null,
  channelId: 'chan-1',
  sharedSecret: Buffer.alloc(32, 0x42).toString('base64'),
}

function decodeFrame(frame: any): any {
  return JSON.parse(Buffer.from(frame.ciphertext, 'base64').toString('utf-8'))
}

describe('LAN auth immediate heartbeat', () => {
  beforeEach(() => {
    relayInstances = []
    lanInstances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handleLanAuthResponse calls onAuthenticated after recomputeState', () => {
    const order: string[] = []
    const ctx: LanAuthCtx = {
      lan: {
        sendRaw: () => {},
        rekeyClient: () => {},
        getClientIp: () => '10.0.0.2',
        recordAuthSuccess: () => {},
      } as any,
      lanAuthPending: new Map([['lan-1', { nonce: 'test-nonce', timeout: setTimeout(() => {}, 10_000) }]]),
      lanDeviceMap: new Map(),
      deviceSecrets: new Map(),
      getPairedDevice: () => DEVICE,
      recomputeState: () => { order.push('recompute') },
      emit: () => {},
      onAuthenticated: (deviceId) => { order.push(`heartbeat:${deviceId}`) },
    }
    handleLanAuthResponse(ctx, {
      seq: 0,
      payload: JSON.stringify({ type: 'auth_response', deviceId: DEVICE.id, proof: 'p' }),
    } as any, 'lan-1')
    // recomputeState first (so _deliverFrame routes over the new LAN socket),
    // then the heartbeat callback. Red on unfixed code: onAuthenticated never
    // fires, so order is ['recompute'] only.
    expect(order).toEqual(['recompute', `heartbeat:${DEVICE.id}`])
  })

  it('RemoteTransport delivers an immediate desktop_heartbeat over LAN on auth completion', async () => {
    const transport = new RemoteTransport({
      relayUrl: 'wss://relay.example.com',
      relayApiKey: 'test-key',
      lanPort: 0,
      getPairedDevice: (id) => (id === DEVICE.id ? DEVICE : null),
      getAllPairedDevices: () => [DEVICE],
    })
    await transport.start()
    const lan = lanInstances[lanInstances.length - 1]

    // Simulate the LAN handshake: raw connect registers the pending nonce,
    // then the device's auth_response completes auth.
    lan.emit('raw-client-connected', {}, 'lan-1')
    lan.emit('message', {
      seq: 0,
      payload: JSON.stringify({ type: 'auth_response', deviceId: DEVICE.id, proof: 'p' }),
    }, 'lan-1')

    // Immediately after auth — no timers advanced — one heartbeat frame must
    // already be on the LAN socket. Red on unfixed code: zero heartbeat
    // frames until the 15s interval fires.
    const heartbeats = lan.sent.filter((s) => decodeFrame(s.frame).type === 'desktop_heartbeat')
    expect(heartbeats).toHaveLength(1)
    // Truthful payload seq: the heartbeat's payload seq equals its own
    // envelope seq (same invariant the interval heartbeat pins).
    expect(decodeFrame(heartbeats[0].frame).seq).toBe(heartbeats[0].frame.seq)
    await transport.stop()
  })
})
