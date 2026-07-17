/**
 * transport-seq-routing.test.ts
 *
 * Regression coverage for three multi-device transport defects:
 *
 *  1. Per-device outbound seq counters. A single shared counter gave each of N
 *     paired devices a strided subsequence (stride ≈ N), so iOS gap detection
 *     fired on nearly every frame and the resulting desktop_request_resend was
 *     never satisfiable (the retransmit buffer is per-device and never held
 *     the other devices' seqs) — a permanent resend → complete:false →
 *     desktop_resend_unavailable storm.
 *  2. Windowed inbound dedup at the transport seam (out-of-order distinct
 *     seqs from iOS's concurrent Tasks must not be dropped as duplicates).
 *  3. Inbound relay frames must reach the command handler even when a stale
 *     (half-open zombie) LAN map entry exists for the device — the old drop
 *     blackholed all relay commands until 'client-disconnected' fired.
 *
 * Crypto and compression are mocked to reversible transforms so the tests can
 * decode delivered frames and build inbound ones.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Reversible stand-ins: compress = utf-8 encode, encrypt = base64 of the
// compressed buffer. Lets the tests decode outbound frames and craft inbound.
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

// Instance capture. The mock classes are defined INSIDE the factories (the
// factories are hoisted; a module-level class would be in its temporal dead
// zone when the factory runs). Constructors only touch these arrays at
// runtime, after the module body has initialized them.
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
    hasClientResult = false
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

const DEVICES = [
  { id: 'device-1', channelId: 'chan-1' },
  { id: 'device-2', channelId: 'chan-2' },
]

function pairedDevice(d: { id: string; channelId: string }) {
  return {
    id: d.id,
    name: `Test ${d.id}`,
    pairedAt: new Date().toISOString(),
    lastSeen: null,
    channelId: d.channelId,
    sharedSecret: Buffer.alloc(32, 0x42).toString('base64'),
  }
}

async function startTransport(): Promise<{ transport: RemoteTransport; relays: MockRelay[]; lan: MockLan }> {
  const transport = new RemoteTransport({
    relayUrl: 'wss://relay.example.com',
    relayApiKey: 'test-key',
    lanPort: 0,
    getPairedDevice: (id) => {
      const d = DEVICES.find((x) => x.id === id)
      return d ? pairedDevice(d) : null
    },
    getAllPairedDevices: () => DEVICES.map(pairedDevice),
  })
  await transport.start()
  // Mark every relay live so _deliverFrame hands frames to relay.send.
  for (const relay of relayInstances) {
    relay.connected = true
    relay.emit('connected')
  }
  return { transport, relays: [...relayInstances], lan: lanInstances[lanInstances.length - 1] }
}

/** Decode the RemoteEvent payload from a mock-encrypted outbound frame. */
function decodeFrame(frame: any): any {
  return JSON.parse(Buffer.from(frame.ciphertext, 'base64').toString('utf-8'))
}

/** Build a mock-encrypted inbound frame carrying a RemoteCommand. */
function inboundFrame(seq: number, cmd: object): any {
  return {
    seq,
    ts: Date.now(),
    deviceId: 'ios',
    nonce: 'n',
    ciphertext: Buffer.from(JSON.stringify(cmd), 'utf-8').toString('base64'),
  }
}

describe('RemoteTransport — per-device seq, dedup, relay routing', () => {
  beforeEach(() => {
    relayInstances = []
    lanInstances = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers contiguous seqs 1,2,3 to EVERY paired device (per-device counters)', async () => {
    const { transport, relays } = await startTransport()
    expect(relays).toHaveLength(2)

    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)

    // With the shared counter each device saw a strided subsequence
    // (e.g. [1,3,5] and [2,4,6]); per-device counters give both [1,2,3].
    for (const relay of relays) {
      expect(relay.sent.map((f) => f.seq)).toEqual([1, 2, 3])
    }
    await transport.stop()
  })

  it('satisfies a resend for the exact seqs a device received (complete, no resend_unavailable)', async () => {
    const { transport, relays } = await startTransport()
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)

    const relay1 = relays[0]
    const before = relay1.sent.length
    transport.resend(DEVICES[0].id, 1, 3)

    const replayed = relay1.sent.slice(before)
    // Byte-identical replay of the exact three frames this device received.
    // Under the shared counter device-1 never held seq 2 (it belonged to
    // device-2), the range came back incomplete, and a fourth frame carrying
    // desktop_resend_unavailable was sent instead.
    expect(replayed.map((f) => f.seq)).toEqual([1, 2, 3])
    expect(replayed.map((f) => decodeFrame(f).type)).toEqual([
      'desktop_status', 'desktop_status', 'desktop_status',
    ])
    expect(relay1.sent.some((f) => decodeFrame(f).type === 'desktop_resend_unavailable')).toBe(false)
    await transport.stop()
  })

  it('sends per-device heartbeats whose payload seq is that device\'s own counter', async () => {
    vi.useFakeTimers()
    const { transport, relays } = await startTransport()
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)
    transport.send({ type: 'desktop_status', tabId: 't', fields: {} } as any)

    vi.advanceTimersByTime(15_000)

    for (const relay of relays) {
      const heartbeats = relay.sent.map(decodeFrame).filter((e) => e.type === 'desktop_heartbeat')
      expect(heartbeats).toHaveLength(1)
      // Each device has sent 2 frames, so its counter reads 2 at heartbeat
      // build time. The old broadcast stamped the GLOBAL counter (4 with two
      // devices) into every device's heartbeat.
      expect(heartbeats[0].seq).toBe(2)
    }
    await transport.stop()
  })

  it('accepts out-of-order inbound seqs instead of dropping real commands', async () => {
    const { transport, relays } = await startTransport()
    const commands: Array<{ cmd: any; deviceId: string }> = []
    transport.on('command', (cmd, deviceId) => commands.push({ cmd, deviceId }))

    const relay1 = relays[0]
    relay1.emit('message', inboundFrame(192, { type: 'desktop_get_snapshot' }))
    // Late frame from a concurrent iOS Task / old socket: DISTINCT lower seq.
    // The strict high-water mark dropped this as a "duplicate".
    relay1.emit('message', inboundFrame(147, { type: 'desktop_get_snapshot' }))
    // A genuine duplicate replay is still dropped.
    relay1.emit('message', inboundFrame(192, { type: 'desktop_get_snapshot' }))

    expect(commands).toHaveLength(2)
    expect(commands.every((c) => c.deviceId === DEVICES[0].id)).toBe(true)
    await transport.stop()
  })

  it('routes inbound relay frames to the command handler despite a stale LAN map entry', async () => {
    const { transport, relays, lan } = await startTransport()

    // Authenticate device-1 over LAN so lanDeviceMap holds an entry for it.
    lan.emit('raw-client-connected', {}, 'lan-1')
    lan.emit('message', { payload: JSON.stringify({ type: 'auth_response', deviceId: DEVICES[0].id, proof: 'p' }) }, 'lan-1')

    // Simulate the half-open zombie: the LAN socket still registers as a
    // client (hasClient true) but nothing ever arrives on it, and
    // 'client-disconnected' never fires to clean lanDeviceMap.
    lan.hasClientResult = true

    const commands: Array<{ cmd: any; deviceId: string }> = []
    transport.on('command', (cmd, deviceId) => commands.push({ cmd, deviceId }))

    // iOS falls back to relay; the old code discarded this frame because a LAN
    // entry existed, blackholing every inbound relay command.
    relays[0].emit('message', inboundFrame(1, { type: 'desktop_get_snapshot' }))

    expect(commands).toHaveLength(1)
    expect(commands[0].cmd.type).toBe('desktop_get_snapshot')
    expect(commands[0].deviceId).toBe(DEVICES[0].id)
    await transport.stop()
  })

  it('LAN auth starts a new inbound epoch: seq 1 after a poisoned high mark is accepted', async () => {
    const { transport, relays, lan } = await startTransport()
    const commands: any[] = []
    transport.on('command', (cmd) => commands.push(cmd))

    // Previous epoch left a high mark beyond the dedup window.
    relays[0].emit('message', inboundFrame(1000, { type: 'desktop_get_snapshot' }))
    expect(commands).toHaveLength(1)

    // iOS re-auths over LAN and restarts its outbound seq at 1.
    lan.emit('raw-client-connected', {}, 'lan-1')
    lan.emit('message', { payload: JSON.stringify({ type: 'auth_response', deviceId: DEVICES[0].id, proof: 'p' }) }, 'lan-1')

    lan.emit('message', inboundFrame(1, { type: 'desktop_get_snapshot' }), 'lan-1')
    expect(commands).toHaveLength(2)
    await transport.stop()
  })
})
