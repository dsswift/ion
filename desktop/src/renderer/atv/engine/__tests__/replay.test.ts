import { describe, it, expect } from 'vitest'
import { advanceReplay, makeReplayState, seekReplay } from '../replay'
import type { ReplayFrame } from '../../state/recorder'

const frames: ReplayFrame[] = [
  { atMs: 1000, kind: 'snapshot', agents: [] },
  { atMs: 2000, kind: 'event', event: { type: 'dispatch_start' } as never },
  { atMs: 3000, kind: 'snapshot', agents: [] },
  { atMs: 4000, kind: 'event', event: { type: 'dispatch_end' } as never },
]

describe('advanceReplay', () => {
  it('yields due frames in order at 1x and respects speed multipliers', () => {
    const s = makeReplayState(1000)
    expect(advanceReplay(s, frames, 1, 5000)).toHaveLength(1) // 1000→2000
    s.speed = 4
    expect(advanceReplay(s, frames, 0.5, 5000)).toHaveLength(2) // 2000→4000
  })
  it('clamps at the end and stops playing; paused yields nothing', () => {
    const s = makeReplayState(3500)
    expect(advanceReplay(s, frames, 10, 4000)).toHaveLength(1)
    expect(s.playing).toBe(false)
    expect(advanceReplay(s, frames, 10, 4000)).toEqual([])
  })
})

describe('seekReplay', () => {
  const nearest = (t: number) => {
    let best = -1
    frames.forEach((f, i) => {
      if (f.atMs <= t && f.kind === 'snapshot') best = i
    })
    return best
  }
  it('rebuilds from the nearest snapshot with catchup events', () => {
    const s = makeReplayState(0)
    const r = seekReplay(s, frames, 3500, nearest)
    expect(r.snapshotIndex).toBe(2)
    expect(r.catchup).toEqual([])
    const r2 = seekReplay(s, frames, 2500, nearest)
    expect(r2.snapshotIndex).toBe(0)
    expect(r2.catchup.map((f) => f.atMs)).toEqual([2000])
  })
  it('before any snapshot: index -1, all frames up to t as catchup', () => {
    const s = makeReplayState(0)
    const r = seekReplay(s, frames, 500, nearest)
    expect(r.snapshotIndex).toBe(-1)
    expect(r.catchup).toEqual([])
  })
})
