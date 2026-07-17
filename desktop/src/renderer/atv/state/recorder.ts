/**
 * recorder — session-replay data layer: a bounded ring of stamped frames
 * (agent-state snapshots + canvas-relevant events) for the active tab.
 * Consecutive identical snapshots (heartbeats) dedupe by status signature.
 * Presentation-layer timestamps (Date.now at ingestion) — never sim/gen.
 */
import type { AgentStateUpdate, NormalizedEvent } from '../../../shared/types'

export type ReplayFrame =
  | { atMs: number; kind: 'snapshot'; agents: AgentStateUpdate[] }
  | { atMs: number; kind: 'event'; event: NormalizedEvent }

export const FRAME_CAP = 6000
export const WINDOW_CAP_MS = 30 * 60 * 1000

function snapshotSig(agents: AgentStateUpdate[]): string {
  return agents.map((a) => `${a.name}:${a.status}`).sort().join(',')
}

export class AtvRecorder {
  readonly frames: ReplayFrame[] = []
  private lastSig = ''

  clear(): void {
    this.frames.length = 0
    this.lastSig = ''
  }

  recordSnapshot(agents: AgentStateUpdate[], atMs: number): void {
    const sig = snapshotSig(agents)
    if (sig === this.lastSig) return // heartbeat: nothing changed
    this.lastSig = sig
    this.push({ atMs, kind: 'snapshot', agents })
  }

  recordEvent(event: NormalizedEvent, atMs: number): void {
    this.push({ atMs, kind: 'event', event })
  }

  private push(frame: ReplayFrame): void {
    this.frames.push(frame)
    if (this.frames.length > FRAME_CAP) this.frames.splice(0, this.frames.length - FRAME_CAP)
    const cutoff = frame.atMs - WINDOW_CAP_MS
    while (this.frames.length > 0 && this.frames[0].atMs < cutoff) this.frames.shift()
  }

  /** Recorded time window ({0,0} when empty). */
  window(): { startMs: number; endMs: number } {
    if (this.frames.length === 0) return { startMs: 0, endMs: 0 }
    return { startMs: this.frames[0].atMs, endMs: this.frames[this.frames.length - 1].atMs }
  }

  /** Index of the latest snapshot at or before t (-1 when none). */
  nearestSnapshotAt(tMs: number): number {
    let best = -1
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i]
      if (f.atMs > tMs) break
      if (f.kind === 'snapshot') best = i
    }
    return best
  }

  /** Frames with atMs in (t0, t1], in order. */
  framesBetween(t0: number, t1: number): ReplayFrame[] {
    return this.frames.filter((f) => f.atMs > t0 && f.atMs <= t1)
  }
}
