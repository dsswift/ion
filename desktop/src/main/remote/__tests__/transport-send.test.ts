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
import { enqueueSend, drainSendQueue, sendToAll, frameWithinWireCap, MAX_PLAINTEXT_BYTES, type SendCtx } from '../transport-send'
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
      { event: { type: CRITICAL, text: '1' } as any, push: false, enqueuedAt: 0 },
      { event: { type: CRITICAL, text: '2' } as any, push: false, enqueuedAt: 0 },
      { event: { type: CRITICAL, text: '3' } as any, push: false, enqueuedAt: 0 },
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

  it('transport.ts sendToDevice routes through the shared gate (source pin)', () => {
    // The direct path bypasses sendToAll; without this gate an oversized
    // frame from sendToDevice would slip past the receivers' read limits.
    const src = readFileSync(join(__dirname, '../transport.ts'), 'utf-8')
    const sendToDeviceBody = src.slice(src.indexOf('sendToDevice(deviceId: string'), src.indexOf('resend(deviceId: string'))
    expect(sendToDeviceBody).toContain('frameWithinWireCap')
  })
})
