import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for the machine-freezing wedge: the send queue must drain
// even when the paired iOS peer is unreachable, so a streaming run to an asleep
// device cannot grow the queue without bound (the O(n^2) main-thread spin that
// froze the app). Durability is delegated to the retransmit buffer, which must
// still receive every frame.

// buildDeviceFrame does real crypto; stub it to a fixed frame so the test
// exercises the queue-drain logic, not encryption.
vi.mock('../transport-frame', () => ({
  buildDeviceFrame: vi.fn(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' })),
}))
vi.mock('../../logger', () => ({ log: vi.fn() }))

import { enqueueSend, drainSendQueue, type SendCtx } from '../transport-send'

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
