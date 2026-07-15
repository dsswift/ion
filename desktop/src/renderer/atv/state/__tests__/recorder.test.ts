import { describe, it, expect } from 'vitest'
import { AtvRecorder, FRAME_CAP, WINDOW_CAP_MS } from '../recorder'
import type { AgentStateUpdate, NormalizedEvent } from '../../../../shared/types'

function agents(status: string): AgentStateUpdate[] {
  return [{ name: 'dev', status, metadata: {} } as unknown as AgentStateUpdate]
}
const evt = { type: 'dispatch_start', dispatchAgent: 'dev' } as unknown as NormalizedEvent

describe('AtvRecorder', () => {
  it('dedupes heartbeat snapshots by status signature', () => {
    const r = new AtvRecorder()
    r.recordSnapshot(agents('running'), 100)
    r.recordSnapshot(agents('running'), 200) // heartbeat
    r.recordSnapshot(agents('done'), 300)
    expect(r.frames).toHaveLength(2)
  })

  it('caps by frame count and by time window', () => {
    const r = new AtvRecorder()
    for (let i = 0; i < FRAME_CAP + 100; i++) r.recordEvent(evt, i)
    expect(r.frames.length).toBeLessThanOrEqual(FRAME_CAP)
    r.recordEvent(evt, WINDOW_CAP_MS + 10_000)
    expect(r.frames[0].atMs).toBeGreaterThanOrEqual(10_000)
  })

  it('window, nearest snapshot, and framesBetween', () => {
    const r = new AtvRecorder()
    r.recordSnapshot(agents('running'), 100)
    r.recordEvent(evt, 200)
    r.recordSnapshot(agents('done'), 300)
    r.recordEvent(evt, 400)
    expect(r.window()).toEqual({ startMs: 100, endMs: 400 })
    expect(r.nearestSnapshotAt(250)).toBe(0)
    expect(r.nearestSnapshotAt(350)).toBe(2)
    expect(r.nearestSnapshotAt(50)).toBe(-1)
    expect(r.framesBetween(100, 300)).toHaveLength(2)
  })

  it('clear resets state and the dedupe signature', () => {
    const r = new AtvRecorder()
    r.recordSnapshot(agents('running'), 100)
    r.clear()
    r.recordSnapshot(agents('running'), 200)
    expect(r.frames).toHaveLength(1)
  })
})
