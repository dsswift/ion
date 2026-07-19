import { describe, it, expect, vi, beforeEach } from 'vitest'

// Two-lane send prioritization: bulk payloads (snapshot / terminal_snapshot /
// conversation_history / other large reconcile-semantics events) must not
// head-of-line-block interactive traffic (text deltas, status, tool events).
// FIFO is preserved WITHIN each lane; a starvation guard promotes a bulk item
// older than BULK_STARVATION_MS ahead of interactive traffic; backpressure
// (MAX_QUEUE_SIZE cap + oldest-non-critical eviction) spans both lanes
// combined.
//
// Note on test mechanics: enqueueSend drains synchronously after each push, so
// the queue never holds two items in normal flow. The lane-ordering tests
// therefore push items directly into ctx.sendQueue and call drainSendQueue
// once, observing delivery order via the buildDeviceFrame mock's eventType
// argument (arg index 4).

const { buildFrameMock } = vi.hoisted(() => ({
  buildFrameMock: vi.fn((..._args: unknown[]): any => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' })),
}))
vi.mock('../transport-frame', () => ({
  buildDeviceFrame: (...args: unknown[]) => buildFrameMock(...args),
}))
vi.mock('../../logger', () => ({ log: vi.fn(), error: vi.fn() }))

import {
  enqueueSend,
  drainSendQueue,
  laneForEventType,
  nextSendIndex,
  BULK_STARVATION_MS,
  MAX_QUEUE_SIZE,
  type SendCtx,
  type SendQueueItem,
} from '../transport-send'
import { log as logSpy } from '../../logger'

function makeCtx(): SendCtx & { retransmitRecord: ReturnType<typeof vi.fn> } {
  const retransmitRecord = vi.fn()
  let seq = 0
  return {
    sendQueue: [],
    deviceSecrets: new Map([['dev1', Buffer.alloc(32)]]),
    retransmit: { record: retransmitRecord } as any,
    nextSeq: () => ++seq,
    deliverFrame: () => true,
    retransmitRecord,
  }
}

/** Event types delivered, in order, as observed at the frame-build seam. */
function deliveredTypes(): string[] {
  return buildFrameMock.mock.calls.map((args) => args[4] as string)
}

function item(type: string, enqueuedAt: number): SendQueueItem {
  return { event: { type } as any, push: false, enqueuedAt, lane: laneForEventType(type) }
}

describe('laneForEventType — classifier', () => {
  it('routes large reconcile payloads to the bulk lane', () => {
    expect(laneForEventType('desktop_snapshot')).toBe('bulk')
    expect(laneForEventType('desktop_terminal_snapshot')).toBe('bulk')
    expect(laneForEventType('desktop_conversation_history')).toBe('bulk')
    // Other paged/large content responses found in protocol.ts also classify
    // bulk (several ship via the unqueued sendToDevice path today, but the
    // classifier keys on payload nature so future queued sends land right).
    expect(laneForEventType('desktop_agent_conversation_history')).toBe('bulk')
    expect(laneForEventType('desktop_settings_snapshot')).toBe('bulk')
    expect(laneForEventType('desktop_plan_content')).toBe('bulk')
    expect(laneForEventType('desktop_resource_content')).toBe('bulk')
    expect(laneForEventType('desktop_fs_file_content')).toBe('bulk')
    expect(laneForEventType('desktop_fs_image_content')).toBe('bulk')
  })

  it('routes live interactive traffic to the interactive lane', () => {
    expect(laneForEventType('desktop_text_delta')).toBe('interactive')
    expect(laneForEventType('desktop_status')).toBe('interactive')
    expect(laneForEventType('desktop_tool_start')).toBe('interactive')
    expect(laneForEventType('desktop_stream_reset')).toBe('interactive')
    expect(laneForEventType('desktop_permission_request')).toBe('interactive')
  })
})

describe('drainSendQueue — lane prioritization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFrameMock.mockImplementation(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' }))
  })

  it('delivers an interactive delta enqueued AFTER a bulk snapshot FIRST (no head-of-line blocking)', () => {
    const ctx = makeCtx()
    const now = Date.now()
    // Snapshot enqueued first (queue head), delta behind it — the exact
    // head-of-line-blocking arrangement. Red on unfixed FIFO code, which
    // shifts the snapshot first.
    ctx.sendQueue.push(item('desktop_snapshot', now), item('desktop_text_delta', now))
    drainSendQueue(ctx)

    expect(ctx.sendQueue.length).toBe(0)
    expect(deliveredTypes()).toEqual(['desktop_text_delta', 'desktop_snapshot'])
  })

  it('preserves FIFO within each lane', () => {
    const ctx = makeCtx()
    const now = Date.now()
    ctx.sendQueue.push(
      item('desktop_snapshot', now),
      item('desktop_text_delta', now),
      item('desktop_terminal_snapshot', now),
      item('desktop_stream_reset', now),
      item('desktop_text_delta', now),
    )
    drainSendQueue(ctx)

    // Interactive lane in push order first, then bulk lane in push order.
    expect(deliveredTypes()).toEqual([
      'desktop_text_delta',
      'desktop_stream_reset',
      'desktop_text_delta',
      'desktop_snapshot',
      'desktop_terminal_snapshot',
    ])
  })

  it('starvation guard: a bulk item older than BULK_STARVATION_MS delivers before a newer interactive item', () => {
    const ctx = makeCtx()
    const now = Date.now()
    // Interactive at the queue head so unfixed FIFO ALSO delivers it first —
    // the guard, not FIFO, must be what promotes the over-age bulk item.
    ctx.sendQueue.push(
      item('desktop_text_delta', now),
      item('desktop_snapshot', now - BULK_STARVATION_MS - 500), // over-age
    )
    drainSendQueue(ctx)

    expect(deliveredTypes()).toEqual(['desktop_snapshot', 'desktop_text_delta'])
  })

  it('bulk item under the starvation threshold does NOT jump interactive', () => {
    const ctx = makeCtx()
    const now = Date.now()
    ctx.sendQueue.push(
      item('desktop_snapshot', now - BULK_STARVATION_MS + 500), // not yet over-age
      item('desktop_text_delta', now),
    )
    drainSendQueue(ctx)

    expect(deliveredTypes()).toEqual(['desktop_text_delta', 'desktop_snapshot'])
  })

  it('bulk drains normally when the interactive lane is empty', () => {
    const ctx = makeCtx()
    const now = Date.now()
    ctx.sendQueue.push(item('desktop_snapshot', now), item('desktop_conversation_history', now))
    drainSendQueue(ctx)

    expect(deliveredTypes()).toEqual(['desktop_snapshot', 'desktop_conversation_history'])
  })
})

describe('nextSendIndex — selection policy unit', () => {
  it('returns -1 on an empty queue', () => {
    expect(nextSendIndex([], Date.now())).toBe(-1)
  })

  it('picks the first interactive item when no bulk is starving', () => {
    const now = Date.now()
    const queue = [item('desktop_snapshot', now), item('desktop_text_delta', now)]
    expect(nextSendIndex(queue, now)).toBe(1)
  })

  it('picks the oldest starving bulk item ahead of interactive', () => {
    const now = Date.now()
    const queue = [
      item('desktop_text_delta', now),
      item('desktop_snapshot', now - BULK_STARVATION_MS - 1),
    ]
    expect(nextSendIndex(queue, now)).toBe(1)
  })
})

describe('enqueueSend — backpressure across lanes combined', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    buildFrameMock.mockImplementation(() => ({ seq: 1, ts: 0, deviceId: 'dev1', nonce: '', ciphertext: '' }))
  })

  it('drops a non-critical enqueue when the combined queue is at MAX_QUEUE_SIZE', () => {
    const ctx = makeCtx()
    const now = Date.now()
    // Mixed-lane fill: both lanes count toward the single cap.
    for (let i = 0; i < MAX_QUEUE_SIZE; i++) {
      ctx.sendQueue.push(item(i % 2 === 0 ? 'desktop_snapshot' : 'desktop_text_delta', now))
    }
    // desktop_text_chunk is NOT in CRITICAL_TYPES: dropped before push/drain.
    enqueueSend(ctx, { type: 'desktop_text_chunk', tabId: 't', text: 'x' } as any, false)

    expect(ctx.sendQueue.length).toBe(MAX_QUEUE_SIZE) // unchanged, not drained
    expect(buildFrameMock).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      'RemoteTransport',
      expect.stringContaining('backpressure'),
      expect.objectContaining({ event_type: 'desktop_text_chunk' }),
    )
  })

  it('evicts the oldest non-critical item regardless of lane when a critical event arrives at cap', () => {
    const ctx = makeCtx()
    const now = Date.now()
    // Oldest non-critical is a BULK item (desktop_resource_content is not in
    // CRITICAL_TYPES) sitting at index 3, behind critical interactive items —
    // eviction must find it across lanes, not per-lane.
    for (let i = 0; i < 3; i++) ctx.sendQueue.push(item('desktop_text_delta', now))
    ctx.sendQueue.push(item('desktop_resource_content', now)) // non-critical, bulk
    for (let i = 0; i < MAX_QUEUE_SIZE - 4; i++) ctx.sendQueue.push(item('desktop_text_delta', now))
    expect(ctx.sendQueue.length).toBe(MAX_QUEUE_SIZE)

    enqueueSend(ctx, { type: 'desktop_text_delta', text: 'new' } as any, false)

    // Everything drained; the evicted resource_content was never built.
    expect(ctx.sendQueue.length).toBe(0)
    expect(deliveredTypes()).not.toContain('desktop_resource_content')
    // 500 pre-filled - 1 evicted + 1 new = 500 frames built.
    expect(buildFrameMock).toHaveBeenCalledTimes(MAX_QUEUE_SIZE)
  })
})
