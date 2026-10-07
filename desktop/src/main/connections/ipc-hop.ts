/**
 * The IPC hop: what the Electron renderer waits through on top of the wire.
 *
 * Main's `ClientWireLatency` times a `studio_action` from leaving this
 * process to its result arriving. The renderer that asked waits longer: its
 * frame crosses the preload bridge to main and the result crosses back. The
 * renderer reports its own round trip for each frame id (`hostNoteActionTiming`),
 * this meter subtracts main's figure for the same id, and the difference is
 * the hop. Its p50 per environment rides the client window line as
 * `ipc_hop_p50_ms`, beside the wire figures it was measured against.
 *
 * Either side may report first: a renderer result is seen after main's
 * (main relays it), but the renderer's one-way IPC can still land before
 * `noteMainResult` runs in a busy tick. Both halves are held until paired.
 */
import { ELECTRON_CLIENT_WINDOW_FIELDS } from '@ion/shared/client-wire-latency'

export const IPC_HOP_FIELD: (typeof ELECTRON_CLIENT_WINDOW_FIELDS)[number] = 'ipc_hop_p50_ms'

/** How long an unpaired half is kept before it is dropped as never answered. */
const UNPAIRED_TTL_MS = 60_000

interface Half { ms: number; atMs: number }

interface EnvironmentHops {
  mainMs: Map<string, Half>
  rendererMs: Map<string, Half>
  hops: number[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return Math.round(sorted[Math.min(rank, sorted.length) - 1])
}

export class IpcHopMeter {
  private readonly byEnvironment = new Map<string, EnvironmentHops>()
  private readonly sentAt = new Map<string, number>()

  private envFor(environmentId: string): EnvironmentHops {
    let env = this.byEnvironment.get(environmentId)
    if (!env) {
      env = { mainMs: new Map(), rendererMs: new Map(), hops: [] }
      this.byEnvironment.set(environmentId, env)
    }
    return env
  }

  /** A `studio_action` left main. */
  noteSent(environmentId: string, id: string, nowMs: number = Date.now()): void {
    // A send never answered (timed out, connection dropped) would otherwise stay forever.
    for (const [key, at] of this.sentAt) if (nowMs - at > UNPAIRED_TTL_MS) this.sentAt.delete(key)
    this.sentAt.set(`${environmentId}\u0000${id}`, nowMs)
  }

  /** How many sends are waiting for a result (test use). */
  pendingSends(): number {
    return this.sentAt.size
  }

  /** Its result reached main. Unknown ids (a result for a previous connection's action) are ignored. */
  noteMainResult(environmentId: string, id: string, nowMs: number = Date.now()): void {
    const key = `${environmentId}\u0000${id}`
    const sent = this.sentAt.get(key)
    if (sent === undefined) return
    this.sentAt.delete(key)
    this.pair(environmentId, id, { ms: nowMs - sent, atMs: nowMs }, 'main')
  }

  /** The renderer's own round trip for the same frame id. */
  noteRendererResult(environmentId: string, id: string, rendererMs: number, nowMs: number = Date.now()): void {
    this.pair(environmentId, id, { ms: rendererMs, atMs: nowMs }, 'renderer')
  }

  private pair(environmentId: string, id: string, half: Half, side: 'main' | 'renderer'): void {
    const env = this.envFor(environmentId)
    const mine = side === 'main' ? env.mainMs : env.rendererMs
    const theirs = side === 'main' ? env.rendererMs : env.mainMs
    const other = theirs.get(id)
    if (!other) {
      mine.set(id, half)
      this.expire(env, half.atMs)
      return
    }
    theirs.delete(id)
    const renderer = side === 'renderer' ? half.ms : other.ms
    const main = side === 'main' ? half.ms : other.ms
    env.hops.push(Math.max(0, renderer - main))
  }

  private expire(env: EnvironmentHops, nowMs: number): void {
    for (const map of [env.mainMs, env.rendererMs]) {
      for (const [id, half] of map) if (nowMs - half.atMs > UNPAIRED_TTL_MS) map.delete(id)
    }
  }

  /** The hop's p50 for one environment over the window so far, or null with no paired sample. */
  p50(environmentId: string): number | null {
    const env = this.byEnvironment.get(environmentId)
    if (!env || env.hops.length === 0) return null
    return percentile([...env.hops].sort((a, b) => a - b), 50)
  }

  /** How many hops were paired for one environment in the window so far. */
  samples(environmentId: string): number {
    return this.byEnvironment.get(environmentId)?.hops.length ?? 0
  }

  /** Start a fresh window for one environment (the client window line was written). */
  reset(environmentId: string): void {
    const env = this.byEnvironment.get(environmentId)
    if (env) env.hops = []
  }

  /** Forget an environment entirely. */
  forget(environmentId: string): void {
    this.byEnvironment.delete(environmentId)
    for (const key of [...this.sentAt.keys()]) if (key.startsWith(`${environmentId}\u0000`)) this.sentAt.delete(key)
  }

  /**
   * Adds the hop figure to one client window line's fields, when the window
   * had a paired sample, and starts the environment's next window. Shaped as
   * the writer `ClientWireLatency` takes, so the broker composes the two.
   */
  decorate(fields: Record<string, unknown>): Record<string, unknown> {
    const environmentId = fields.environment_id
    if (typeof environmentId !== 'string') return fields
    const p50 = this.p50(environmentId)
    this.reset(environmentId)
    return p50 === null ? fields : { ...fields, [IPC_HOP_FIELD]: p50 }
  }
}
