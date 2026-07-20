import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), error: vi.fn() }))

import { startHeartbeat, stopHeartbeat, sendHeartbeatTo, sendHeartbeatsTick, type HeartbeatCtx } from '../transport-heartbeat'

function makeCtx(overrides: Partial<HeartbeatCtx> = {}): HeartbeatCtx & { sent: { deviceId: string; event: any }[] } {
  const sent: { deviceId: string; event: any }[] = []
  return {
    deviceSecrets: new Map([['dev1', Buffer.alloc(32)], ['dev2', Buffer.alloc(32)]]),
    seqs: new Map([['dev1', 5]]),
    queuedCount: () => 3,
    sendToDevice: (deviceId, event) => { sent.push({ deviceId, event }) },
    intervalMs: 15_000,
    sent,
    ...overrides,
  }
}

describe('transport-heartbeat', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sendHeartbeatTo sends a desktop_heartbeat carrying ts, buffered, and predicted next seq', () => {
    const ctx = makeCtx()
    sendHeartbeatTo(ctx, 'dev1')
    expect(ctx.sent).toHaveLength(1)
    expect(ctx.sent[0].deviceId).toBe('dev1')
    expect(ctx.sent[0].event.type).toBe('desktop_heartbeat')
    // Predicted next seq = current counter (5) + 1.
    expect(ctx.sent[0].event.seq).toBe(6)
    expect(ctx.sent[0].event.buffered).toBe(3)
    expect(typeof ctx.sent[0].event.ts).toBe('number')
  })

  it('predicts seq 1 for a device with no counter yet', () => {
    const ctx = makeCtx()
    sendHeartbeatTo(ctx, 'dev2') // not in seqs map
    expect(ctx.sent[0].event.seq).toBe(1)
  })

  it('sendHeartbeatsTick sends one frame to every paired device', () => {
    const ctx = makeCtx()
    sendHeartbeatsTick(ctx)
    expect(ctx.sent.map((s) => s.deviceId).sort()).toEqual(['dev1', 'dev2'])
  })

  it('startHeartbeat fires a tick every interval; stopHeartbeat halts it', () => {
    const ctx = makeCtx()
    const timer = startHeartbeat(ctx)
    expect(ctx.sent).toHaveLength(0) // no immediate tick; first fires after one interval

    vi.advanceTimersByTime(15_000)
    expect(ctx.sent).toHaveLength(2) // dev1 + dev2

    vi.advanceTimersByTime(15_000)
    expect(ctx.sent).toHaveLength(4)

    const cleared = stopHeartbeat(timer)
    expect(cleared).toBeNull()
    vi.advanceTimersByTime(30_000)
    expect(ctx.sent).toHaveLength(4) // no further ticks after stop
  })

  it('stopHeartbeat tolerates a null timer', () => {
    expect(stopHeartbeat(null)).toBeNull()
  })
})
