/**
 * One environment's connection inside the broker (`broker.ts`): the socket,
 * the `studio_hello`/`studio_welcome` handshake, the retry ladder, and the
 * frames held until the wire is welcomed. Frames after the handshake pass
 * through UNCHANGED.
 */
import type { StudioSocketLike } from './transport-relay'
import { sendFrame } from './send-frame'
import { decodeFrame, encodeFrame, decodeBinary, encodeBinary, WireError } from '@ion/shared/studio-wire/codec'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import type { StudioCredential, StudioFrame } from '@ion/shared/studio-wire/types'
import type { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { log as _log, warn as _warn, debug as _debug } from '../logger'
import type { ConnectionPhase, ConnectionTransportKind } from './phases'
import { startMainSpan } from '../spans'
import type { Span } from '@ion/shared/trace-context'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-broker', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('connections-broker', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-broker', msg, fields)
}

/** One environment the broker can connect to. */
export interface ConnectionTarget {
  environmentId: string
  label: string
  /**
   * The transport this target is expected to reach the server over, used
   * for the `connecting` phase before an attempt has resolved one. Replaced
   * by whatever `open()` actually resolved, so a paired target that falls
   * back to a relay reports `relay` from that attempt on.
   */
  transport: ConnectionTransportKind
  clientId: string
  /**
   * Reverse-command families this client answers (`client-capabilities.ts`),
   * sent in `studio_hello` so the server routes `studio_command`s here.
   */
  capabilities?: readonly string[]
  /**
   * Runs ONE connection attempt end to end: picks the route, derives the
   * credential, and opens the socket. The broker calls it again for every
   * retry, so everything it does is per-attempt.
   *
   * Rejecting is an ordinary failed attempt — it rides the same backoff
   * ladder as a socket that closes, and so recovers on its own. Resolution
   * used to happen in the CALLER before `connect()` was ever reached, which
   * meant an environment whose server was down at that moment produced no
   * connection at all, and with no connection there was nothing to retry: it
   * stayed dark until the operator noticed and clicked Reconnect.
   *
   * The credential is derived here, per attempt, because a paired proof is
   * an HMAC over a server nonce that rotates and resets on restart; a proof
   * computed once at connect time is refused by a server that has since
   * restarted.
   */
  open(): Promise<ConnectionAttempt>
}

/** What one `ConnectionTarget.open()` resolved: the route it took, the credential for the hello, and the socket. */
export interface ConnectionAttempt {
  transport: ConnectionTransportKind
  credential: StudioCredential
  socket: StudioSocketLike
  /** The route the attempt resolved (`tcp` | `relay` | `local`), an attribute of its `connection.connect` span. Defaults to the transport. */
  route?: string
}

/** Attempt ladder for a failed connection: five attempts within five minutes, then a slower retry forever (see OFFLINE_RETRY_MS below). */
const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000]
const BACKOFF_WINDOW_MS = 5 * 60_000
const MAX_ATTEMPTS = 5
/**
 * Once the ladder above is exhausted, retry forever at this slower, gentle
 * cadence instead of stopping. `phase: 'offline'` still fires at that point
 * (the UI reads it as "disconnected" exactly as before), but it is no
 * longer a dead end -- an environment left disconnected across a server
 * restart or a long network outage recovers on its own instead of
 * requiring the operator to notice and click Reconnect. Matches
 * `renderer/host/BrowserStudioHost.ts`'s identical constant for the same
 * reason the ladder above does.
 */
const OFFLINE_RETRY_MS = 30_000
export const ACTION_TIMEOUT_MS = 30_000

/**
 * Frames held while the wire is not ready yet. Bounded because an
 * environment that never comes up must not grow this without limit; the
 * oldest is dropped first and the drop is logged, never silent.
 */
export const MAX_PENDING_FRAMES = 256

export class EnvironmentConnection {
  phase: ConnectionPhase
  private ws: StudioSocketLike | null = null
  private attempts = 0
  private windowStartMs = 0
  private closedByUser = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Queued until the server answers `studio_hello` with `studio_welcome`.
   *
   * `send()` used to drop a frame whenever the socket was not open, which was
   * survivable while the renderer only sent frames in response to a user
   * action -- by then the connection had long since come up. It stops being
   * survivable the moment the renderer routes its ordinary work over this
   * wire, because that work starts during boot: a dropped frame becomes a
   * request that never gets an answer and a promise that hangs until its
   * 30-second timeout.
   *
   * The gate is `studio_welcome`, not socket-open. The server's listener
   * drops any frame that arrives before a successful hello, so flushing on
   * open would trade a local drop for a remote one.
   */
  private pendingFrames: StudioFrame[] = []
  private welcomed = false
  /**
   * The welcome that opened the live connection, kept for a window that
   * attaches after it (see `Broker.replayWelcome`).
   */
  private lastWelcome: StudioFrame | null = null
  /**
   * `connection.connect`: one span per attempt, from the attempt starting to
   * the welcome (or the failure that ends the attempt). Attributes name the
   * environment, the transport the attempt resolved, and its route.
   */
  private connectSpan: Span | null = null

  constructor(
    private readonly target: ConnectionTarget,
    private readonly emitFrame: (environmentId: string, frame: StudioFrame) => void,
    private readonly emitPhase: (environmentId: string, phase: ConnectionPhase) => void,
    private readonly emitBinary: (environmentId: string, channel: BinaryChannel, key: string, payload: Uint8Array) => void,
  ) {
    this.phase = { phase: 'connecting', transport: target.transport }
  }

  /**
   * Monotonic attempt id. Everything between "start an attempt" and "its
   * socket is installed" is async now, so a restart()/disconnect() can land
   * mid-flight; the id is what tells a resolved attempt whether it is still
   * the current one.
   */
  private generation = 0
  /** The route the current attempt resolved, for its span. */
  private attemptRoute: string | null = null

  /** Ends the current attempt's `connection.connect` with the transport it resolved. Idempotent. */
  private endConnectSpan(extra?: Record<string, unknown>, error?: string): void {
    const span = this.connectSpan
    if (!span) return
    this.connectSpan = null
    span.end({ transport: this.target.transport, route: this.attemptRoute ?? this.target.transport, ...(extra ?? {}) }, error)
  }

  connect(): void {
    this.welcomed = false
    this.setPhase({ phase: 'connecting', transport: this.target.transport })
    void this.attempt((this.generation += 1))
  }

  private async attempt(generation: number): Promise<void> {
    this.connectSpan?.end({ attempt: this.attempts }, 'superseded by a later attempt')
    this.connectSpan = startMainSpan('connection.connect', {
      kind: 'client',
      attributes: { 'peer.service': 'ion-server', environment_id: this.target.environmentId, transport: this.target.transport, attempt: this.attempts + 1 },
    })
    let opened: ConnectionAttempt
    try {
      opened = await this.target.open()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (generation !== this.generation) {
        debug('a superseded attempt failed to open; ignoring it', { environment_id: this.target.environmentId, reason })
        this.endConnectSpan(undefined, 'superseded while opening')
        return
      }
      warn('connection attempt could not be opened; it will be retried', { environment_id: this.target.environmentId, reason })
      this.handleFailure(reason)
      return
    }
    if (generation !== this.generation || this.closedByUser) {
      log('closing a socket opened by a superseded attempt', { environment_id: this.target.environmentId, transport: opened.transport })
      opened.socket.close()
      this.endConnectSpan({ transport: opened.transport }, 'superseded after opening')
      return
    }
    this.target.transport = opened.transport
    this.attemptRoute = opened.route ?? opened.transport
    const ws = opened.socket
    this.ws = ws
    // Every listener below checks `this.ws === ws` before acting. A socket
    // this method has already been superseded on -- by a later reconnect or
    // a manual restart() -- keeps firing its own open/message/close/error
    // events until it is garbage-collected, and those late events must
    // never be allowed to act as if they describe whatever connection is
    // current now. Without this guard, a stale `close`/`error` firing after
    // a newer socket had already connected and been welcomed would call
    // handleFailure(), which unconditionally nulls `this.ws` -- wiping out
    // the reference to the healthy newer connection -- and immediately
    // reconnects again. See `renderer/host/BrowserStudioHost.ts`'s
    // identical guard: the exact same defect, live in production there,
    // produced an unbounded reconnect loop that never settled.
    ws.once('open', () => {
      if (this.ws !== ws) return
      this.sendHello(ws, opened.credential)
    })
    ws.on('message', (data: unknown, isBinary: boolean) => {
      if (this.ws !== ws) return
      this.handleMessage(data, isBinary)
    })
    ws.once('close', (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws || this.closedByUser) return
      this.handleFailure(`connection closed: ${code} ${reasonBuf?.toString('utf-8') ?? ''}`.trim())
    })
    ws.once('error', (err: Error) => {
      if (this.ws !== ws) return
      this.handleFailure(err.message)
    })
  }

  private sendHello(ws: StudioSocketLike, credential: StudioCredential): void {
    const hello: StudioFrame = {
      type: 'studio_hello',
      protocolVersion: PROTOCOL_VERSION,
      clientId: this.target.clientId,
      clientKind: 'desktop',
      capabilities: [...(this.target.capabilities ?? [])],
      credential,
    }
    log('sending hello', { environment_id: this.target.environmentId, credential_kind: credential.kind, transport: this.target.transport })
    ws.send(encodeFrame(hello))
  }

  /**
   * `isBinary` (the `ws` library's own frame-opcode flag) decides the path —
   * never a heuristic on the payload's shape. A JSON frame and a binary
   * frame's key/header bytes can coincidentally both "look like" the other
   * once serialized, so the only correct signal is the one the WebSocket
   * protocol itself carries.
   */
  private handleMessage(data: unknown, isBinary: boolean): void {
    if (isBinary) {
      this.handleBinaryMessage(data)
      return
    }
    let frame: StudioFrame
    try {
      frame = decodeFrame(typeof data === 'string' ? data : String(data))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const wire = err instanceof WireError ? err : null
      if (wire?.frameType === 'studio_welcome' && !this.welcomed) {
        // Nothing else will ever open this wire: the server has said its
        // piece and waits for frames. Fail the attempt so the phase says
        // why, instead of sitting in `connecting` with a socket open.
        warn('welcome from server could not be read; failing the attempt', {
          environment_id: this.target.environmentId,
          field: wire.field,
          error,
        })
        const ws = this.ws
        this.handleFailure(`welcome could not be read: field ${wire.field ?? 'unknown'}`, undefined, true)
        ws?.close()
        return
      }
      warn('malformed frame from server; ignoring', {
        environment_id: this.target.environmentId,
        frame_type: wire?.frameType,
        field: wire?.field,
        error,
      })
      return
    }
    if (frame.type === 'studio_ping') {
      // Answered immediately, before anything else this frame could queue
      // behind: the round trip being measured includes whatever we make the
      // server wait for.
      this.send({ type: 'studio_pong', nonce: frame.nonce, t: Date.now() })
      return
    }
    if (frame.type === 'studio_welcome') {
      this.attempts = 0
      this.windowStartMs = 0
      this.welcomed = true
      this.lastWelcome = frame
      this.flushPending()
      this.endConnectSpan({ server_capabilities: frame.capabilities.length })
      this.setPhase({ phase: 'connected', transport: this.target.transport })
    } else if (frame.type === 'studio_refused') {
      this.handleFailure(`refused: ${frame.reason}${frame.detail ? ` (${frame.detail})` : ''}`, frame.reason)
      return
    }
    this.emitFrame(this.target.environmentId, frame)
  }

  private handleBinaryMessage(data: unknown): void {
    const buf = data instanceof Buffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null
    if (!buf) {
      warn('binary frame arrived in an unexpected shape; ignoring', { environment_id: this.target.environmentId, type: typeof data })
      return
    }
    try {
      const decoded = decodeBinary(buf)
      this.emitBinary(this.target.environmentId, decoded.channel, decoded.key, decoded.payload)
    } catch (err) {
      warn('malformed binary frame from server; ignoring', {
        environment_id: this.target.environmentId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** The transport this connection actually opened on (a relay fallback changes it). */
  get transportKind(): ConnectionTransportKind {
    return this.target.transport
  }

  /** What the server said it can do, in the welcome that opened the live connection. Null while there is none. */
  get serverCapabilities(): readonly string[] | null {
    return this.welcomed && this.lastWelcome?.type === 'studio_welcome' ? this.lastWelcome.capabilities : null
  }

  /**
   * Hand the live connection's welcome to the listeners again, then ask the
   * server for a fresh snapshot so they converge on its current state rather
   * than the welcome's. False when there is no live welcome to replay.
   */
  replayWelcome(): boolean {
    if (!this.welcomed || !this.lastWelcome) return false
    this.emitFrame(this.target.environmentId, this.lastWelcome)
    this.send({ type: 'studio_snapshot_request' })
    return true
  }

  send(frame: StudioFrame): void {
    if (!this.welcomed || !this.ws || this.ws.readyState !== this.ws.OPEN) {
      if (this.pendingFrames.length >= MAX_PENDING_FRAMES) {
        const dropped = this.pendingFrames.shift()
        warn('pending frame queue is full; dropped the oldest', {
          environment_id: this.target.environmentId,
          dropped_frame_type: dropped?.type ?? 'unknown',
          queued: this.pendingFrames.length,
        })
      }
      this.pendingFrames.push(frame)
      debug('queued a frame until the wire is ready', {
        environment_id: this.target.environmentId,
        frame_type: frame.type,
        queued: this.pendingFrames.length,
      })
      return
    }
    sendFrame(this.ws, frame)
  }

  /** Send everything held while the wire was coming up, oldest first. */
  private flushPending(): void {
    if (this.pendingFrames.length === 0) return
    const queued = this.pendingFrames
    this.pendingFrames = []
    log('flushing frames queued while the wire was coming up', {
      environment_id: this.target.environmentId,
      count: queued.length,
    })
    for (const frame of queued) if (this.ws) sendFrame(this.ws, frame)
  }

  /** Abandon queued frames when the connection is given up for good. */
  private discardPending(reason: string): void {
    if (this.pendingFrames.length === 0) return
    warn('discarding frames queued for an environment that went offline', {
      environment_id: this.target.environmentId,
      count: this.pendingFrames.length,
      reason,
    })
    this.pendingFrames = []
  }

  sendBinary(channel: BinaryChannel, key: string, payload: Uint8Array): boolean {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) {
      warn('sendBinary attempted with no open connection', { environment_id: this.target.environmentId, channel, key })
      return false
    }
    this.ws.send(encodeBinary(channel, key, payload))
    return true
  }

  private handleFailure(reason: string, refusalReason?: import('@ion/shared/studio-wire/types').StudioRefusalReason, incompatible = false): void {
    this.ws = null
    this.welcomed = false
    // A failure after the welcome has no attempt span open; this is a no-op then.
    this.endConnectSpan(refusalReason ? { refusal_reason: refusalReason } : undefined, reason)
    if (this.closedByUser) return
    const now = Date.now()
    if (now - this.windowStartMs > BACKOFF_WINDOW_MS) {
      this.windowStartMs = now
      this.attempts = 0
    }
    this.attempts += 1
    if (this.attempts > MAX_ATTEMPTS) {
      // Still retries -- see OFFLINE_RETRY_MS's doc comment. `phase` stays
      // 'offline' (its type carries no attempt/nextAttemptAtMs) even though
      // a timer is running underneath it. Pending frames are still
      // discarded: whatever queued them has been waiting since before the
      // ladder exhausted and replaying it minutes later on an eventual
      // reconnect would be a stale action, not a real one.
      this.discardPending(reason)
      this.setPhase({ phase: 'offline', transport: this.target.transport, reason, refusalReason, incompatible })
      this.retryTimer = setTimeout(() => this.connect(), OFFLINE_RETRY_MS)
      return
    }
    const delay = BACKOFF_LADDER_MS[Math.min(this.attempts - 1, BACKOFF_LADDER_MS.length - 1)]
    this.setPhase({
      phase: 'backoff',
      transport: this.target.transport,
      reason,
      refusalReason,
      incompatible,
      attempt: this.attempts,
      nextAttemptAtMs: now + delay,
    })
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  /** Re-arms the backoff ladder from zero and reconnects (a manual "Restart"). */
  restart(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    // Explicitly close whatever's live rather than leaving connect() below
    // to silently overwrite `this.ws` -- the staleness guard on connect()'s
    // listeners makes an orphaned old socket harmless now, but there is no
    // reason to leave a real, still-open connection dangling for the far
    // side to discover and displace a moment later.
    this.ws?.close()
    this.ws = null
    this.attempts = 0
    this.windowStartMs = 0
    this.closedByUser = false
    this.connect()
  }

  disconnect(): void {
    this.closedByUser = true
    this.endConnectSpan(undefined, 'disconnected by user')
    // Invalidates an attempt still resolving, so its socket is closed on
    // arrival instead of installed over a connection the user just ended.
    this.generation += 1
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
  }

  private setPhase(phase: ConnectionPhase): void {
    this.phase = phase
    log('connection phase changed', {
      environment_id: this.target.environmentId,
      phase: phase.phase,
      transport: phase.transport,
      reason: 'reason' in phase ? phase.reason : undefined,
    })
    this.emitPhase(this.target.environmentId, phase)
  }
}
