/**
 * How long the Studio wire takes, per connected client.
 *
 * The measure this replaced timed frames one way, from the desktop to the
 * phone, over a transport that no longer exists (ADR-035 put every client on
 * the Studio wire). One-way timing across two machines needs a clock-skew
 * estimate to mean anything, and that one served a single client kind.
 *
 * This times a round trip on the SERVER's own clock -- `studio_ping` out,
 * `studio_pong` back -- so there is no skew to estimate, and it reads the same
 * for Studio, a browser and a phone, over a local socket, TCP or a relay. The
 * WebSocket-level ping cannot do this job: it carries no payload a client can
 * echo, and on a relayed connection it only reaches the relay.
 *
 * Each connection also carries what only the server can see: how long a frame
 * waited between entering the send queue and leaving the socket, how many
 * bytes went out, how many frames came in, how many failed to decode, and how
 * long the server itself spent on each action, in total and per action name.
 * One INFO line per connection per window, which is what the Ion Wire Latency
 * dashboard reads; the OTLP metrics exporter hears the same window through
 * `onWireWindow` and turns its raw samples into histograms.
 */
import { log as _log } from '../logger'

const TAG = 'wire-latency'

/** How often a connection is probed. Frequent enough to fill a window, cheap enough to ignore. */
export const PING_INTERVAL_MS = 15_000
/** A probe unanswered this long is counted lost rather than waited for forever. */
export const PING_TIMEOUT_MS = 30_000
/** How often each connection's window is written. */
export const WINDOW_INTERVAL_MS = 60_000

/**
 * The field names one window line carries.
 *
 * Exported because the dashboard queries these names, and a panel querying a
 * field nothing emits looks exactly like a quiet system -- which is how the
 * dashboard this replaced sat empty. Its test asserts every `fields_*` it
 * queries is in here.
 */
export const WIRE_WINDOW_FIELDS = [
  'client_kind',
  'client_id',
  'transport',
  'rtt_p50_ms',
  'rtt_p95_ms',
  'rtt_max_ms',
  'rtt_samples',
  'pings_lost',
  'dwell_p50_ms',
  'dwell_p95_ms',
  'dwell_max_ms',
  'queue_max',
  'frames_out',
  'bytes_out',
  'frames_in',
  'decode_errors',
  'action_p50_ms',
  'action_p95_ms',
  'actions',
] as const

/** One action name's figures within a window. */
export interface ActionWindow {
  p50_ms: number
  p95_ms: number
  count: number
}

/** The numbers one window line carries (`WIRE_WINDOW_FIELDS`, by name). */
export interface WireWindow {
  rtt_p50_ms: number
  rtt_p95_ms: number
  rtt_max_ms: number
  rtt_samples: number
  pings_lost: number
  dwell_p50_ms: number
  dwell_p95_ms: number
  dwell_max_ms: number
  queue_max: number
  frames_out: number
  bytes_out: number
  frames_in: number
  decode_errors: number
  /** Over every action of the window, whatever its name. */
  action_p50_ms: number
  action_p95_ms: number
  /** The same, per action name, so one slow action is not averaged into the rest. */
  actions: Record<string, ActionWindow>
}

/** The raw samples of a window, for a consumer that builds its own distribution (the OTLP metrics exporter). */
export interface WireWindowSamples {
  rtts: readonly number[]
  dwells: readonly number[]
}

/**
 * Nearest-rank percentile over a sample set, rounded to a whole millisecond.
 * Zero for an empty set: no samples is not a latency of zero, and the
 * accompanying `*_samples` field is what says which it is.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return Math.round(sorted[Math.min(rank, sorted.length) - 1])
}

/** One connection's counters for the current window. */
export class WireLatencyMeter {
  private rtts: number[] = []
  private dwells: number[] = []
  private actions: number[] = []
  private readonly actionsByName = new Map<string, number[]>()
  private pingsLost = 0
  private framesOut = 0
  private bytesOut = 0
  private framesIn = 0
  private decodeErrors = 0
  private queueMax = 0
  /** Probes sent and not yet answered: nonce → the server clock when it went out. */
  private readonly outstanding = new Map<string, number>()

  /** A frame entered the send queue. `queued` is the queue depth in bytes after it. */
  recordSend(bytes: number, queued: number): void {
    this.framesOut += 1
    this.bytesOut += bytes
    if (queued > this.queueMax) this.queueMax = queued
  }

  /** That frame left the socket. `waitedMs` is how long it sat in the queue. */
  recordSendComplete(waitedMs: number): void {
    this.dwells.push(waitedMs)
  }

  recordInbound(): void {
    this.framesIn += 1
  }

  recordDecodeError(): void {
    this.decodeErrors += 1
  }

  /** The server's own time on one action, receipt to result, under the action's name. */
  recordAction(action: string, ms: number): void {
    this.actions.push(ms)
    let samples = this.actionsByName.get(action)
    if (!samples) {
      samples = []
      this.actionsByName.set(action, samples)
    }
    samples.push(ms)
  }

  /** The window's raw round trips and queue waits so far. Read before `takeWindow` clears them. */
  peekSamples(): WireWindowSamples {
    return { rtts: [...this.rtts], dwells: [...this.dwells] }
  }

  /** A probe went out. */
  recordPingSent(nonce: string, atMs: number): void {
    this.outstanding.set(nonce, atMs)
    this.expireStalePings(atMs)
  }

  /**
   * A probe came back. Returns the round trip, or null for a nonce this
   * connection has no record of -- a reply to a probe already written off as
   * lost, or one this connection never sent.
   */
  recordPong(nonce: string, atMs: number): number | null {
    const sentAt = this.outstanding.get(nonce)
    if (sentAt === undefined) return null
    this.outstanding.delete(nonce)
    const rtt = atMs - sentAt
    this.rtts.push(rtt)
    return rtt
  }

  /** Write off probes older than the timeout so `outstanding` cannot grow without bound. */
  expireStalePings(nowMs: number): void {
    for (const [nonce, sentAt] of this.outstanding) {
      if (nowMs - sentAt >= PING_TIMEOUT_MS) {
        this.outstanding.delete(nonce)
        this.pingsLost += 1
      }
    }
  }

  /** Whether anything happened this window. A silent connection writes no line. */
  hasSamples(): boolean {
    return (
      this.rtts.length > 0 ||
      this.dwells.length > 0 ||
      this.actions.length > 0 ||
      this.framesOut > 0 ||
      this.framesIn > 0 ||
      this.pingsLost > 0 ||
      this.decodeErrors > 0
    )
  }

  /** The window's numbers, and a fresh start. */
  takeWindow(): WireWindow {
    const rtts = [...this.rtts].sort((a, b) => a - b)
    const dwells = [...this.dwells].sort((a, b) => a - b)
    const actions = [...this.actions].sort((a, b) => a - b)
    const byName: Record<string, ActionWindow> = {}
    for (const [name, samples] of [...this.actionsByName].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const sorted = [...samples].sort((a, b) => a - b)
      byName[name] = { p50_ms: percentile(sorted, 50), p95_ms: percentile(sorted, 95), count: sorted.length }
    }
    const window: WireWindow = {
      rtt_p50_ms: percentile(rtts, 50),
      rtt_p95_ms: percentile(rtts, 95),
      rtt_max_ms: rtts.length > 0 ? Math.round(rtts[rtts.length - 1]) : 0,
      rtt_samples: rtts.length,
      pings_lost: this.pingsLost,
      dwell_p50_ms: percentile(dwells, 50),
      dwell_p95_ms: percentile(dwells, 95),
      dwell_max_ms: dwells.length > 0 ? Math.round(dwells[dwells.length - 1]) : 0,
      queue_max: this.queueMax,
      frames_out: this.framesOut,
      bytes_out: this.bytesOut,
      frames_in: this.framesIn,
      decode_errors: this.decodeErrors,
      action_p50_ms: percentile(actions, 50),
      action_p95_ms: percentile(actions, 95),
      actions: byName,
    }
    this.rtts = []
    this.dwells = []
    this.actions = []
    this.actionsByName.clear()
    this.pingsLost = 0
    this.framesOut = 0
    this.bytesOut = 0
    this.framesIn = 0
    this.decodeErrors = 0
    this.queueMax = 0
    return window
  }
}

/** Who a window is about. */
export interface WireWindowIdentity {
  clientKind: string
  clientId: string
  transport: string
  connectionId: string
}

/** Hears every window as it is written, with its raw samples (the OTLP metrics exporter). */
export type WireWindowListener = (identity: WireWindowIdentity, window: WireWindow, samples: WireWindowSamples) => void

const windowListeners = new Set<WireWindowListener>()

/** Call `listener` for every window written by any connection. Returns the unsubscribe. */
export function onWireWindow(listener: WireWindowListener): () => void {
  windowListeners.add(listener)
  return () => { windowListeners.delete(listener) }
}

/** Write one connection's window. Called on the timer and once more as it closes. */
export function logWireWindow(identity: WireWindowIdentity, meter: WireLatencyMeter): void {
  if (!meter.hasSamples()) return
  const samples = meter.peekSamples()
  const window = meter.takeWindow()
  for (const listener of windowListeners) listener(identity, window, samples)
  _log(TAG, 'wire window', {
    client_kind: identity.clientKind,
    client_id: identity.clientId,
    transport: identity.transport,
    connection_id: identity.connectionId,
    ...window,
  })
}
