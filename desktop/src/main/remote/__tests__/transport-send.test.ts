import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for the machine-freezing wedge: the send queue must drain
// even when the paired iOS peer is unreachable, so a streaming run to an asleep
// device cannot grow the queue without bound (the O(n^2) main-thread spin that
// froze the app). Durability is delegated to the retransmit buffer, which must
// still receive every frame.
//
// Also covers the two-stage size gating (B8): the 6 MB plaintext early gate and
// the MAX_WIRE_FRAME_BYTES backstop on the serialized wire frame, which keeps
// undeliverable frames (relay reads cap at 12 MB, iOS at 16 MiB) out of both
// live delivery and the retransmit buffer.

// buildDeviceFrame does real crypto; stub it so the tests exercise the
// queue-drain and size-gate logic, not encryption. `buildFrameMock` is
// re-configurable per test (the frame-cap test needs an oversized frame).
// vi.hoisted so the mock exists when the hoisted vi.mock factory runs.
const { buildFrameMock } = vi.hoisted(() => ({
  buildFrameMock: vi.fn((..._args: unknown[]): any => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' })),
}))
vi.mock('../transport-frame', () => ({
  buildDeviceFrame: (...args: unknown[]) => buildFrameMock(...args),
}))
vi.mock('../../logger', () => ({ log: vi.fn(), error: vi.fn() }))

import { readFileSync } from 'fs'
import { join } from 'path'
import { enqueueSend, enqueueSendToDevice, drainSendQueue, sendToAll, frameWithinWireCap, MAX_PLAINTEXT_BYTES, laneForEventType, type SendCtx } from '../transport-send'
import { MAX_WIRE_FRAME_BYTES } from '../protocol'
import { error as errorSpy } from '../../logger'

function makeCtx(deliverFrame: (deviceId: string, frame: any) => boolean): SendCtx & { retransmitRecord: ReturnType<typeof vi.fn> } {
  const retransmitRecord = vi.fn()
  let seq = 0
  return {
    sendQueue: [],
    deviceSecrets: new Map([['dev1', Buffer.alloc(32)]]),
    retransmit: { record: retransmitRecord } as any,
    nextSeq: () => ++seq,
    deliverFrame,
    retransmitRecord,
  }
}

const CRITICAL = 'desktop_text_delta' // a CRITICAL_TYPE — cannot be backpressure-dropped

describe('drainSendQueue — unreachable peer', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drains the queue even when live delivery fails, and still records for resend', () => {
    const ctx = makeCtx(() => false) // peer asleep: every delivery fails
    enqueueSend(ctx, { type: CRITICAL, text: 'a' } as any, false)

    // Fixed: the item is shifted after its send attempt. (Before the fix the
    // head never shifted on failed delivery, leaving length 1.)
    expect(ctx.sendQueue.length).toBe(0)
    // Durability preserved: the frame is buffered for an iOS resend request.
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(1)
  })

  it('stays bounded when a stream floods an unreachable peer (no O(n^2) spin)', () => {
    const ctx = makeCtx(() => false)
    // Far more than MAX_QUEUE_SIZE (500) critical events, which cannot be
    // dropped by backpressure. Before the fix these piled up unbounded and each
    // enqueue scanned the whole growing queue; after the fix each drains out.
    for (let i = 0; i < 600; i++) {
      enqueueSend(ctx, { type: CRITICAL, text: `t${i}` } as any, false)
      // The queue never accumulates: it is drained on every enqueue.
      expect(ctx.sendQueue.length).toBe(0)
    }
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(600)
  })

  it('delivers and drains normally when the peer is connected', () => {
    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    enqueueSend(ctx, { type: CRITICAL, text: 'a' } as any, false)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ctx.sendQueue.length).toBe(0)
  })

  it('drainSendQueue empties a pre-filled queue regardless of delivery outcome', () => {
    const ctx = makeCtx(() => false)
    ctx.sendQueue.push(
      { event: { type: CRITICAL, text: '1' } as any, push: false, enqueuedAt: 0, lane: 'interactive' },
      { event: { type: CRITICAL, text: '2' } as any, push: false, enqueuedAt: 0, lane: 'interactive' },
      { event: { type: CRITICAL, text: '3' } as any, push: false, enqueuedAt: 0, lane: 'interactive' },
    )
    drainSendQueue(ctx)
    expect(ctx.sendQueue.length).toBe(0)
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(3)
  })
})

describe('sendToAll — two-stage size gating (B8)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Restore the default (normal-size) frame after tests that override it.
    buildFrameMock.mockImplementation(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' }))
  })

  it('drops a frame whose SERIALIZED size exceeds MAX_WIRE_FRAME_BYTES: no delivery, no retransmit record, error logged', () => {
    // The 6 MB plaintext early gate makes an >8 MiB frame unreachable from a
    // real payload in this single-event flow (worst-case incompressible 6 MB
    // plaintext ≈ 8 MB frame after DEFLATE+base64, right at the cap). The
    // frame gate is the authoritative backstop for the cases the plaintext
    // heuristic cannot see (UTF-16-length vs byte drift, envelope overhead,
    // future compression changes), so it is tested at the seam: mock
    // buildDeviceFrame to return an oversized frame.
    const oversizedCiphertext = 'x'.repeat(MAX_WIRE_FRAME_BYTES + 1024)
    buildFrameMock.mockImplementation(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: oversizedCiphertext }))

    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    const sent = sendToAll(ctx, { type: CRITICAL, text: 'small plaintext' } as any, false)

    expect(sent).toBe(false)
    expect(deliver).not.toHaveBeenCalled()
    // A frame that can never be delivered must never be replayable: the size
    // check runs BEFORE ctx.retransmit.record.
    expect(ctx.retransmitRecord).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteTransport',
      expect.stringContaining('oversized wire frame'),
      expect.objectContaining({ event_type: CRITICAL, cap: MAX_WIRE_FRAME_BYTES }),
    )
  })

  it('an oversized frame for one device does not block delivery to the next device', () => {
    // Per-device drop: continue to the next device, not an early return.
    const oversizedCiphertext = 'x'.repeat(MAX_WIRE_FRAME_BYTES + 1024)
    buildFrameMock
      .mockImplementationOnce(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: oversizedCiphertext }))
      .mockImplementationOnce(() => ({ seq: 1, ts: 0, deviceId: 'dev2', nonce: '', ciphertext: 'small' }))

    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    ctx.deviceSecrets.set('dev2', Buffer.alloc(32))
    const sent = sendToAll(ctx, { type: CRITICAL, text: 'a' } as any, false)

    expect(sent).toBe(true)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith('dev2', expect.objectContaining({ deviceId: 'dev2' }))
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(1)
  })

  it('drops plaintext between 6 MB and the old 32 MB cap at the early gate', () => {
    // Red on unfixed code: the old MAX_PLAINTEXT_BYTES was 32 MB, so a ~10 MB
    // plaintext sailed through the early gate, produced a >12 MB wire frame
    // after base64 when poorly compressible, and wedged the relay/iOS receive
    // (their limits: 12 MB / 16 MiB). The gate is now 6 MB.
    expect(MAX_PLAINTEXT_BYTES).toBe(6 * 1024 * 1024)
    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    const tenMB = 'x'.repeat(10 * 1024 * 1024)
    const sent = sendToAll(ctx, { type: CRITICAL, text: tenMB } as any, false)

    expect(sent).toBe(false)
    expect(buildFrameMock).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(ctx.retransmitRecord).not.toHaveBeenCalled()
  })

  it('a normal-size frame passes both gates: recorded then delivered', () => {
    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    const sent = sendToAll(ctx, { type: CRITICAL, text: 'hello' } as any, false)

    expect(sent).toBe(true)
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(errorSpy).not.toHaveBeenCalled()
  })
})

describe('frameWithinWireCap — shared gate for the direct sendToDevice path', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an oversized frame with an error log', () => {
    const oversized = { seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: 'x'.repeat(MAX_WIRE_FRAME_BYTES + 1024) }
    expect(frameWithinWireCap(oversized as any, 'desktop_snapshot', 'dev1')).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith(
      'RemoteTransport',
      expect.stringContaining('oversized wire frame'),
      expect.objectContaining({ event_type: 'desktop_snapshot', device_id: 'dev1', cap: MAX_WIRE_FRAME_BYTES }),
    )
  })

  it('accepts a normal frame silently', () => {
    const frame = { seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: 'small' }
    expect(frameWithinWireCap(frame as any, 'desktop_status', 'dev1')).toBe(true)
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('sendDirect (transport.ts sendToDevice sync-only fallback) routes through the shared gate (source pin)', () => {
    // The direct path bypasses sendToAll; without this gate an oversized
    // frame from sendToDevice would slip past the receivers' read limits.
    // The body was extracted from transport.ts into sendDirect here.
    const src = readFileSync(join(__dirname, '../transport-send.ts'), 'utf-8')
    const sendDirectBody = src.slice(src.indexOf('export function sendDirect('))
    expect(sendDirectBody).toContain('frameWithinWireCap')
    // And transport.ts sendToDevice actually delegates to it (in the sync-only
    // fallback) and to enqueueSendToDevice (when the crypto worker is live).
    const transportSrc = readFileSync(join(__dirname, '../transport.ts'), 'utf-8')
    const sendToDeviceBody = transportSrc.slice(transportSrc.indexOf('sendToDevice(deviceId: string'), transportSrc.indexOf('resend(deviceId: string'))
    expect(sendToDeviceBody).toContain('sendDirect(')
    expect(sendToDeviceBody).toContain('enqueueSendToDevice(')
    expect(sendToDeviceBody).toContain('this.cryptoHost.usingWorker')
  })
})

// ─── Device-targeted queued send (enqueueSendToDevice) ───────────────────────
//
// sendToDevice routes through the SAME ordered drain as broadcasts when the
// crypto worker is live, so a large targeted reply (desktop_terminal_snapshot,
// conversation history, plan/file content) allocates its wire seq in drain
// order relative to in-flight broadcast frames to the same device — instead of
// the old synchronous sendDirect path that delivered immediately and could put
// a higher-seq targeted frame on the wire ahead of an earlier-seq worker frame
// (iOS then saw a forward gap and requested a resend — the terminal-open
// latency spike on low-RTT LAN links).

const SNAPSHOT = 'desktop_terminal_snapshot' // BULK lane + a CRITICAL_TYPE
const OUTPUT = 'desktop_terminal_output'     // interactive lane, not critical

describe('enqueueSendToDevice — device-targeted queued send', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFrameMock.mockImplementation((...args: unknown[]) => {
      // args[0] = deviceId, args[5] = nextSeq(deviceId). Reflect the allocated
      // seq into the frame so delivery-order assertions can read it.
      const deviceId = args[0] as string
      const nextSeq = args[5] as (d: string) => number
      return { seq: nextSeq(deviceId), ts: 0, deviceId, nonce: '', ciphertext: '' }
    })
  })

  it('classifies desktop_terminal_snapshot into the bulk lane', () => {
    expect(laneForEventType(SNAPSHOT)).toBe('bulk')
  })

  it('pushes an item carrying targetDeviceId and the bulk lane, then drains', () => {
    // Delivery fails (peer asleep) so the item is still built/recorded but the
    // queue drains to empty — we assert the item shape mid-flight via a spy on
    // laneForEventType is unnecessary; instead assert the built frame targeted
    // only the one device (below). Here we simply confirm the drain empties.
    const ctx = makeCtx(() => false)
    ctx.deviceSecrets.set('dev2', Buffer.alloc(32))
    enqueueSendToDevice(ctx, 'dev1', { type: SNAPSHOT, tabId: 't', instances: [] } as any, false)
    expect(ctx.sendQueue.length).toBe(0)
  })

  it('builds and delivers ONLY for the target device (other paired devices receive nothing)', () => {
    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    ctx.deviceSecrets.set('dev2', Buffer.alloc(32))
    ctx.deviceSecrets.set('dev3', Buffer.alloc(32))

    enqueueSendToDevice(ctx, 'dev2', { type: SNAPSHOT, tabId: 't', instances: [] } as any, false)

    expect(deliver).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledWith('dev2', expect.objectContaining({ deviceId: 'dev2' }))
    expect(ctx.retransmitRecord).toHaveBeenCalledTimes(1)
    expect(ctx.retransmitRecord).toHaveBeenCalledWith('dev2', expect.any(Object))
  })

  it('a targeted send to a device removed between enqueue and drain delivers nothing', () => {
    const deliver = vi.fn(() => true)
    const ctx = makeCtx(deliver)
    // Push a targeted item for a device that is not in deviceSecrets.
    ctx.sendQueue.push({ event: { type: SNAPSHOT, tabId: 't', instances: [] } as any, push: false, enqueuedAt: 0, lane: 'bulk', targetDeviceId: 'gone' })
    drainSendQueue(ctx)
    expect(deliver).not.toHaveBeenCalled()
    expect(ctx.retransmitRecord).not.toHaveBeenCalled()
    expect(ctx.sendQueue.length).toBe(0)
  })

  it('regression pin (seq ordering): routing the targeted send through the queue keeps wire seqs monotonic; synchronous delivery does not', () => {
    // The hazard: the broadcast (desktop_terminal_output) rides the worker path
    // and its delivery is DEFERRED (thread hop). The targeted snapshot allocates
    // from the SAME per-device seq counter. If the targeted send is delivered
    // SYNCHRONOUSLY (the old sendDirect path), it grabs the higher seq yet hits
    // the socket first → out-of-order wire seqs → iOS forward-gap + resend.
    // Routing the targeted send through the SAME queue defers it too, so the
    // worker replies in FIFO seq order and the wire stays monotonic.
    //
    // This test contrasts both deliveries against one shared seq counter and a
    // deferred worker, and asserts the queued path is the monotonic one.

    function run(targetedSynchronously: boolean): number[] {
      const deliveredSeqs: number[] = []
      const submittedJobs: { seq: number }[] = []
      const cryptoHost = {
        usingWorker: true,
        submit: (_p: string, _t: string, devices: { deviceId: string; seq: number }[]) => {
          submittedJobs.push({ seq: devices[0].seq })
          return true
        },
      }
      let seq = 0
      const ctx: SendCtx = {
        sendQueue: [],
        deviceSecrets: new Map([['dev1', Buffer.alloc(32)]]),
        retransmit: { record: vi.fn() } as any,
        nextSeq: () => ++seq,
        deliverFrame: (_d, f: any) => { deliveredSeqs.push(f.seq); return true },
        epoch: 1,
        cryptoHost: cryptoHost as any,
      }

      // 1. Broadcast (pty output) enters the worker — delivery deferred.
      enqueueSend(ctx, { type: OUTPUT, tabId: 't', instanceId: 'i', data: 'x' } as any, false)

      if (targetedSynchronously) {
        // OLD behavior: sendDirect allocates from the shared counter and
        // delivers IMMEDIATELY, ahead of the still-deferred broadcast frame.
        const s = ctx.nextSeq('dev1')
        ctx.deliverFrame('dev1', { seq: s } as any)
      } else {
        // NEW behavior: route through the same queue; delivery deferred + FIFO.
        enqueueSendToDevice(ctx, 'dev1', { type: SNAPSHOT, tabId: 't', instances: [] } as any, false)
      }

      // Worker replies in FIFO submit order.
      for (const j of submittedJobs) deliveredSeqs.push(j.seq)
      return deliveredSeqs
    }

    // OLD path: targeted frame (seq 2) lands before the deferred broadcast
    // (seq 1) → [2, 1], non-monotonic — the exact bug.
    expect(run(true)).toEqual([2, 1])
    // NEW path: both deferred, FIFO → [1, 2], strictly increasing.
    const fixed = run(false)
    expect(fixed).toEqual([1, 2])
    for (let i = 1; i < fixed.length; i++) {
      expect(fixed[i]).toBeGreaterThan(fixed[i - 1])
    }
  })
})
