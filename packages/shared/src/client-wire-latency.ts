/**
 * What the Studio wire feels like from this client.
 *
 * The server measures the network and its own work (`server/src/protocol/
 * wire-latency.ts`). Neither includes the part a person actually waits
 * through: an action leaving this process and its result arriving back. So
 * each client reports its own, and the dashboard shows the two together --
 * a low server time beside a high client time is the wire, not the work.
 *
 * One line per environment per window, into this process's own log.
 */

/** The tag every client window line carries. */
export const CLIENT_WIRE_LATENCY_TAG = 'wire-latency'

/**
 * How a client writes its line. Injected because the two clients that share
 * this meter log through different things -- Electron's main process through
 * `main/logger.ts`, a browser tab through `rendererLogger` and `POST /log` --
 * and this package runs in both.
 */
export type ClientWindowLogger = (tag: string, msg: string, fields: Record<string, unknown>) => void

/** How often each environment's window is written. Matches the server's. */
export const CLIENT_WINDOW_INTERVAL_MS = 60_000

/**
 * The field names one client window line carries. Exported for the same
 * reason the server's are: the dashboard queries them, and a panel reading a
 * field nothing emits is indistinguishable from a quiet system.
 */
export const CLIENT_WINDOW_FIELDS = [
  'environment_id',
  'transport',
  'action_p50_ms',
  'action_p95_ms',
  'action_max_ms',
  'actions',
  'action_timeouts',
] as const

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return Math.round(sorted[Math.min(rank, sorted.length) - 1])
}

interface EnvironmentWindow {
  durations: number[]
  timeouts: number
  transport: string
  /** Actions sent and not yet answered: frame id → the clock when it went out. */
  outstanding: Map<string, number>
}

export class ClientWireLatency {
  private readonly windows = new Map<string, EnvironmentWindow>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly write: ClientWindowLogger) {}

  private windowFor(environmentId: string): EnvironmentWindow {
    let window = this.windows.get(environmentId)
    if (!window) {
      window = { durations: [], timeouts: 0, transport: 'unknown', outstanding: new Map() }
      this.windows.set(environmentId, window)
    }
    return window
  }

  /** An action left this process. */
  noteActionSent(environmentId: string, id: string, transport: string, nowMs: number = Date.now()): void {
    const window = this.windowFor(environmentId)
    window.transport = transport
    window.outstanding.set(id, nowMs)
  }

  /** Its result came back. Unknown ids are ignored: a result for an action from a previous connection. */
  noteActionResult(environmentId: string, id: string, nowMs: number = Date.now()): void {
    const window = this.windowFor(environmentId)
    const sentAt = window.outstanding.get(id)
    if (sentAt === undefined) return
    window.outstanding.delete(id)
    window.durations.push(nowMs - sentAt)
  }

  /**
   * An action gave up waiting. Counted rather than folded into the
   * percentiles: a timeout is a different event from a slow answer, and
   * averaging it in would make the wire look merely sluggish.
   */
  noteActionTimeout(environmentId: string, id: string): void {
    const window = this.windowFor(environmentId)
    window.outstanding.delete(id)
    window.timeouts += 1
  }

  /** Write every environment's window, and start fresh. */
  flush(): void {
    for (const [environmentId, window] of this.windows) {
      if (window.durations.length === 0 && window.timeouts === 0) continue
      const sorted = [...window.durations].sort((a, b) => a - b)
      this.write(CLIENT_WIRE_LATENCY_TAG, 'client window', {
        environment_id: environmentId,
        transport: window.transport,
        action_p50_ms: percentile(sorted, 50),
        action_p95_ms: percentile(sorted, 95),
        action_max_ms: sorted.length > 0 ? Math.round(sorted[sorted.length - 1]) : 0,
        actions: sorted.length,
        action_timeouts: window.timeouts,
      })
      window.durations = []
      window.timeouts = 0
    }
  }

  /** Start the window timer. Idempotent. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), CLIENT_WINDOW_INTERVAL_MS)
    this.timer.unref?.()
  }

  /** Stop the timer, writing one final window. */
  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  /** Forget an environment's window entirely (its connection is gone for good). */
  forget(environmentId: string): void {
    this.windows.delete(environmentId)
  }
}
