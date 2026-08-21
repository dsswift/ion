/**
 * replay — the session-replay driver: advances a replay clock at a chosen
 * speed and yields the recorded frames that became due. Pure state-machine
 * core (tested); the engine glue feeds due frames through the same
 * diffSnapshots/eventIntents pipeline live events use.
 *
 * Semantics note: replay is SEMANTICALLY deterministic (status transitions,
 * deliveries, bubbles re-derive from the recorded frames) but not visually
 * bit-identical — ambient wandering draws from a live RNG stream. That is
 * by design; do not fight it.
 */
import type { ReplayFrame } from '../state/recorder'

export type ReplaySpeed = 1 | 4 | 16

export interface ReplayState {
  /** Current replay position (ms, recorder timebase). */
  clockMs: number
  playing: boolean
  speed: ReplaySpeed
}

export function makeReplayState(startMs: number): ReplayState {
  return { clockMs: startMs, playing: true, speed: 1 }
}

/**
 * Advance the clock by dt (seconds of wall time) at the current speed and
 * return the frames that became due, in order. Clamps at endMs and stops.
 */
export function advanceReplay(
  state: ReplayState,
  frames: readonly ReplayFrame[],
  dtSeconds: number,
  endMs: number,
): ReplayFrame[] {
  if (!state.playing) return []
  const prev = state.clockMs
  state.clockMs = Math.min(endMs, prev + dtSeconds * 1000 * state.speed)
  if (state.clockMs >= endMs) state.playing = false
  return frames.filter((f) => f.atMs > prev && f.atMs <= state.clockMs)
}

/**
 * Seek: position the clock at tMs and return { snapshotIndex, catchup } —
 * the rebuild snapshot plus the events between it and tMs (fast-applied
 * without walk animations by the caller).
 */
export function seekReplay(
  state: ReplayState,
  frames: readonly ReplayFrame[],
  tMs: number,
  nearestSnapshotAt: (t: number) => number,
): { snapshotIndex: number; catchup: ReplayFrame[] } {
  state.clockMs = tMs
  const snapshotIndex = nearestSnapshotAt(tMs)
  const fromMs = snapshotIndex >= 0 ? frames[snapshotIndex].atMs : -Infinity
  const catchup = frames.filter((f, i) => i !== snapshotIndex && f.atMs > fromMs && f.atMs <= tMs)
  return { snapshotIndex, catchup }
}
